// Share flow — PLAN.md §2.3.
// Instant share buttons (A/B/C) and the Edit & Share Custom modal run the
// same pipeline: ack → connection check → idempotency guard → optional image
// fetch+upload → LinkedIn post (real or mock) → shares insert → feedback →
// card counter update → first-share reaction.

const copy = require('../copy');
const { buildPostCard, isPostExpired, postCardText } = require('../blocks/postCard');
const { decryptToken } = require('../crypto/tokenCipher');
const { buildSharePayload } = require('../linkedin/posts');
const { getConnection, clearConnection, sendConnectPrompt } = require('../slack/connectPrompt');
const { postEphemeralSafely } = require('../slack/ephemeral');
const { fetchSlackFile } = require('../slack/files');
const { loadPostCards } = require('../db/postCards');

// LinkedIn's commentary limit and the caption+URL budget rule — the same
// shared module the /create-post modal enforces, so the two can't drift.
const { CAPTION_MAX, captionWithUrlError } = require('../linkedin/limits');

const CUSTOM_MODAL_CALLBACK_ID = 'share_custom_modal';
const SHARE_ACTION_PATTERN = /^share_variation_[abc]$/;
const PG_UNIQUE_VIOLATION = '23505';

// A pending share older than this can only be a pipeline that was cut off
// (crash, redeploy) or one whose result could not be saved: every live step
// is bounded by HTTP timeouts far below it.
const PENDING_STALE_MS = 5 * 60 * 1000;

// Layer 1 of the idempotency guard (§2.3 step 2): absorbs double-clicks
// in-process. Layer 2 is the partial unique index on shares, which covers
// the 'pending' reservation row each run inserts before calling LinkedIn.
const inFlight = new Set();
// Every pipeline promise still running, so shutdown can wait for them
// (drainSharePipelines) instead of cutting one off between the LinkedIn post
// and its shares row.
const runningPipelines = new Set();

// A 401 means the member revoked the token — but only on LinkedIn's REST
// endpoints. The image CDN PUT (pre-signed URL) can 401 for its own reasons
// (expired upload URL), which is a share failure, not a revocation.
const is401 = (err) => err.response?.status === 401 && !err.isCdnUpload;
const linkedinErrorText = (err) =>
  err.response?.data?.message || err.data?.error || err.message || 'unknown error';
// Never log the raw error object here: axios errors carry the whole request
// config, including the Authorization header — the member's plaintext
// LinkedIn access token (or the Slack bot token for file fetches), the very
// values tokenCipher.js encrypts at rest. Status + message is enough to
// debug, same discipline as routes/auth.js's OAuth exchange.
const linkedinErrorLogLine = (err) =>
  `${err.response?.status || ''} ${linkedinErrorText(err)}`.trim();

// Trigger point 3 from §2.2: LinkedIn said 401 mid-share (token revoked on
// their side) — treat identically to "not connected": clear the stored
// connection so getConnection agrees, then run the connect flow.
async function handleRevokedToken({ db, config, client }, { userId, channelId }) {
  await clearConnection(db, userId);
  await sendConnectPrompt({ client, config }, { channelId, userId });
}

// Card refreshes for one post run one at a time. Two concurrent shares each
// read the share count; without this, the older read can finish last and
// leave the card one share behind. In-memory is enough: the app is a single
// process (PLAN.md §3). post id -> { tail, state } of the latest refresh.
const cardRefreshQueues = new Map();
// Slack's WebClient has no request timeout by default, so a hung refresh
// must not hold the next one (and its share pipeline) forever: after this
// long the next refresh runs anyway, and the hung one is marked superseded
// so it writes nothing more if it ever wakes up with its older count.
const CARD_REFRESH_WAIT_MS = 20_000;

function queueCardRefresh(postId, refresh) {
  const previous = cardRefreshQueues.get(postId);
  const state = { superseded: false };
  let timer;
  const waitCap = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (previous) previous.state.superseded = true;
      resolve();
    }, CARD_REFRESH_WAIT_MS);
    timer.unref?.();
  });
  const run = Promise.race([previous ? previous.tail : Promise.resolve(), waitCap])
    .finally(() => clearTimeout(timer))
    .then(() => refresh(state));
  const entry = { tail: run.catch(() => {}), state };
  cardRefreshQueues.set(postId, entry);
  entry.tail.then(() => {
    if (cardRefreshQueues.get(postId) === entry) cardRefreshQueues.delete(postId);
  });
  return run;
}

// Counter segment of the card's context line (§2.3 step 6), plus the
// nice-to-have ✅ reaction on the first successful share only. A post can have
// been broadcast to several channels; every card is refreshed so the counter
// stays in sync everywhere (one card's Slack failure doesn't block the rest).
function updateCardCounter(deps, post) {
  return queueCardRefresh(post.id, (state) => refreshCards(deps, post, state));
}

async function refreshCards({ db, client, logger }, post, state) {
  // Re-read the row rather than trusting the pipeline's snapshot: a share
  // that lands moments before expires_at races the expiry cron, and
  // rebuilding from a snapshot whose expired_at is still null would put the
  // Share buttons back on a card the job just stripped — permanently, since
  // the job never revisits a stamped post. Deriving "closed" from
  // expires_at as well covers the sliver where the job has updated the card
  // but not stamped expired_at yet.
  const fresh = (await db('posts').where({ id: post.id }).first()) || post;
  const expiredAt = fresh.expired_at || (isPostExpired(fresh) ? new Date() : null);
  const cards = await loadPostCards(db, fresh);
  if (cards.length === 0) return;
  const [{ count }] = await db('shares')
    .where({ post_id: fresh.id, status: 'success' })
    .count();
  const shareCount = Number(count);
  const blocks = buildPostCard({ post: { ...fresh, expired_at: expiredAt }, shareCount });
  for (const card of cards) {
    if (state.superseded) return; // a newer refresh owns the cards now
    try {
      await client.chat.update({
        channel: card.slack_channel_id,
        ts: card.slack_message_ts,
        text: postCardText(fresh),
        blocks,
      });
    } catch (err) {
      logger.warn(`Card counter update failed: ${err.data?.error || err.message}`);
    }
    if (shareCount === 1 && !state.superseded) {
      try {
        await client.reactions.add({
          channel: card.slack_channel_id,
          timestamp: card.slack_message_ts,
          name: 'white_check_mark',
        });
      } catch (err) {
        // The bot can add a given emoji only once; races here are harmless.
        if (err.data?.error !== 'already_reacted') {
          logger.warn(`First-share reaction failed: ${err.data?.error || err.message}`);
        }
      }
    }
  }
}

// The person's reservation or successful share for this post, if any.
function findActiveShare(db, postId, userId) {
  return db('shares')
    .where({ post_id: postId, slack_user_id: userId })
    .whereIn('status', ['pending', 'success'])
    .first();
}

// One successful share per person per post (Decision #12), and never a blind
// retry of a share whose outcome is unknown. A stale reservation is closed
// as failed so the person's next click (after checking LinkedIn) can proceed.
async function respondToActiveShare({ db, client, logger }, share, { channelId, userId }) {
  if (share.status === 'success') {
    await postEphemeralSafely({ client, logger }, channelId, userId, copy.C4);
    return;
  }
  if (Date.now() - new Date(share.shared_at).getTime() < PENDING_STALE_MS) {
    await postEphemeralSafely({ client, logger }, channelId, userId, copy.C13);
    return;
  }
  await db('shares').where({ id: share.id, status: 'pending' }).update({
    status: 'failed',
    error_message: 'outcome unknown: the share was interrupted before its result was saved',
  });
  await postEphemeralSafely({ client, logger }, channelId, userId, copy.C14);
}

// Steps 1–6 of §2.3. Runs after the interaction is acked; all feedback is
// ephemeral in the channel where the user clicked.
async function runSharePipeline(deps, job) {
  const run = sharePipeline(deps, job);
  runningPipelines.add(run);
  try {
    return await run;
  } finally {
    runningPipelines.delete(run);
  }
}

// -> true once every pipeline running now has finished, false if timeoutMs
// passed first. Bolt acks the interaction before the pipeline runs, so
// stopping the HTTP server alone does not wait for them.
async function drainSharePipelines(timeoutMs) {
  if (runningPipelines.size === 0) return true;
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const finished = Promise.allSettled([...runningPipelines]).then(() => true);
  const drained = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  return drained;
}

async function sharePipeline(
  { config, db, shareClient, client, logger, fetchFile = fetchSlackFile },
  { postId, variation, customText, userId, channelId }
) {
  const lockKey = `${postId}:${userId}`;
  if (inFlight.has(lockKey)) return; // double-click; first click's outcome is coming
  inFlight.add(lockKey);
  // Set once the reservation row exists / once LinkedIn has accepted the
  // post; the catch-all below needs both to pick a truthful message.
  let shareId = null;
  let published = false;
  try {
    const post = await db('posts').where({ id: postId }).first();
    if (!post) {
      await postEphemeralSafely({ client, logger }, channelId, userId, '😕 This post no longer exists.');
      return;
    }

    // The post-expiry job only removes the card's buttons on its own cron
    // cadence, so a click that lands in that gap (or a stale card left open
    // in someone's browser) must still be rejected here, authoritatively.
    if (isPostExpired(post)) {
      await postEphemeralSafely({ client, logger }, channelId, userId, copy.C12);
      return;
    }

    // Durable idempotency pre-check (Decision #12): one successful share per
    // person per post, any variation, and no second run while one is pending.
    const active = await findActiveShare(db, postId, userId);
    if (active) {
      await respondToActiveShare({ db, client, logger }, active, { channelId, userId });
      return;
    }

    // Trigger points 1–2 (§2.2): no/cleared token or expired → connect flow.
    const connection = await getConnection(db, userId);
    if (!connection) {
      await sendConnectPrompt({ client, config }, { channelId, userId });
      return;
    }
    let accessToken;
    try {
      accessToken = decryptToken(connection.linkedin_access_token, config.tokenEncryptionKey);
    } catch {
      // Undecryptable (e.g. rotated TOKEN_ENCRYPTION_KEY) — same as not connected.
      await sendConnectPrompt({ client, config }, { channelId, userId });
      return;
    }

    const commentary =
      variation === 'CUSTOM' ? customText : post[`caption_${variation.toLowerCase()}`];
    if (!commentary) {
      await postEphemeralSafely(
        { client, logger },
        channelId,
        userId,
        '😕 That caption variation is no longer available — try another button on the card.'
      );
      return;
    }

    // Reserve before anything leaves the process: if the result can't be
    // saved later (DB error, restart), this row still blocks a blind retry
    // that would publish the same post twice.
    try {
      [{ id: shareId }] = await db('shares')
        .insert({
          post_id: postId,
          slack_user_id: userId,
          variation,
          custom_text: variation === 'CUSTOM' ? customText : null,
          status: 'pending',
        })
        .returning('id');
    } catch (err) {
      // Layer 2 caught a race the pre-check missed (e.g. across a restart).
      if (err.code !== PG_UNIQUE_VIOLATION) throw err;
      const winner = await findActiveShare(db, postId, userId);
      await postEphemeralSafely(
        { client, logger },
        channelId,
        userId,
        winner?.status === 'success' ? copy.C4 : copy.C13
      );
      return;
    }

    const recordFailure = async (errorMessage) => {
      await db('shares')
        .where({ id: shareId })
        .update({ status: 'failed', error_message: errorMessage.slice(0, 2000) });
    };
    const failShare = async (errorMessage) => {
      await recordFailure(errorMessage);
      // LinkedIn error bodies can be huge (payload echoes); an untruncated one
      // would push C6 past Slack's message limit and the user would get
      // nothing at all. The full text is in the shares row.
      const brief =
        errorMessage.length > 400 ? `${errorMessage.slice(0, 400)}…` : errorMessage;
      await postEphemeralSafely(
        { client, logger },
        channelId,
        userId,
        copy.C6(brief, `<@${config.marketerSlackIds[0]}>`)
      );
    };

    // Image (§2.3 step 3): Slack fetch + upload under the SHARER's token —
    // LinkedIn image assets belong to the member who uploads them. Failure is
    // loud (§2.1): sharing without the approved image is not acceptable.
    let imageUrn = null;
    if (post.image_slack_file_id) {
      try {
        const bytes = await fetchFile(
          { client, botToken: config.slackBotToken },
          post.image_slack_file_id
        );
        imageUrn = await shareClient.uploadImage({
          accessToken,
          personId: connection.linkedin_person_id,
          bytes,
        });
      } catch (err) {
        if (is401(err)) {
          await recordFailure('LinkedIn token revoked (401 on image upload)');
          await handleRevokedToken({ db, config, client }, { userId, channelId });
          return;
        }
        logger.error(`Share image step failed: ${linkedinErrorLogLine(err)}`);
        await failShare(`image upload failed: ${linkedinErrorText(err)}`);
        return;
      }
    }

    const payload = buildSharePayload({
      personId: connection.linkedin_person_id,
      commentary,
      destinationUrl: post.destination_url,
      imageUrn,
    });
    // Decision #19 relies on LinkedIn's own crawler unfurling the URL
    // embedded in commentary — unverified against a real destination site
    // as of this writing. Logged so a "no preview" report can be checked
    // against what actually shipped without re-deriving it from the DB.
    // Bolt's real Logger interface has debug/info/warn/error — no `.log`
    // (unlike console, which the mock LinkedIn client elsewhere assumes).
    logger.info(
      `LinkedIn payload for post ${postId}: commentary ${payload.commentary.length} chars, ` +
        `content=${payload.content ? Object.keys(payload.content)[0] : 'none (link unfurl expected)'}`
    );

    let postUrn = null;
    try {
      postUrn = await shareClient.createPost({ accessToken, payload });
      published = true;
    } catch (err) {
      if (is401(err)) {
        await recordFailure('LinkedIn token revoked (401)');
        await handleRevokedToken({ db, config, client }, { userId, channelId });
        return;
      }
      logger.error(`LinkedIn post failed: ${linkedinErrorLogLine(err)}`);
      await failShare(linkedinErrorText(err));
      return;
    }

    await db('shares')
      .where({ id: shareId })
      .update({ status: 'success', linkedin_post_urn: postUrn });

    await postEphemeralSafely({ client, logger }, channelId, userId, copy.C3);
    try {
      await updateCardCounter({ db, client, logger }, post);
    } catch (err) {
      // The share itself succeeded and the user has been told so (C3) — a
      // failed counter refresh is cosmetic and must not fall into the
      // catch-all below, which would tell them to retry (retrying only
      // yields C4 "already shared").
      logger.warn(`Card counter update failed after a successful share: ${err.message}`);
    }
  } catch (err) {
    logger.error('Share pipeline failed', err);
    if (published) {
      // LinkedIn already has the post; only saving the result failed. "Try
      // again" would publish it twice; the pending row blocks that, and
      // the person hears the truth: it's shared.
      await postEphemeralSafely({ client, logger }, channelId, userId, copy.C3);
      return;
    }
    if (shareId) {
      // Nothing reached LinkedIn: release the reservation so a retry works.
      try {
        await db('shares')
          .where({ id: shareId, status: 'pending' })
          .update({ status: 'failed', error_message: `pipeline error: ${err.message}`.slice(0, 2000) });
      } catch (releaseErr) {
        logger.warn(`Could not release share reservation ${shareId}: ${releaseErr.message}`);
      }
    }
    await postEphemeralSafely(
      { client, logger },
      channelId,
      userId,
      '😕 Something went wrong sharing this post — please try again.'
    );
  } finally {
    inFlight.delete(lockKey);
  }
}

// Pre-filled with Caption A (§2.3); {post_id, channel_id} rides in
// private_metadata so the submission can run the pipeline and respond in the
// right channel. destination_url rides along too so the submission's
// caption+URL budget check needs no DB read inside Slack's 3-second ack
// window — a slow-but-alive DB there would blow the deadline and show the
// marketer Slack's opaque timeout banner.
function buildCustomShareModal({ post, channelId }) {
  return {
    type: 'modal',
    callback_id: CUSTOM_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      post_id: post.id,
      channel_id: channelId,
      destination_url: post.destination_url,
    }),
    title: { type: 'plain_text', text: 'Edit & share' },
    submit: { type: 'plain_text', text: 'Share to LinkedIn' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'custom_caption',
        label: { type: 'plain_text', text: 'Your caption' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: CAPTION_MAX,
          initial_value: post.caption_a,
        },
      },
    ],
  };
}

function registerShareHandlers(app, { config, db, shareClient, fetchFile }) {
  app.action(SHARE_ACTION_PATTERN, async ({ ack, body, action, client, logger }) => {
    await ack();
    let value;
    try {
      value = JSON.parse(action.value);
    } catch {
      logger.error(`Unparseable share button value: ${action.value}`);
      return;
    }
    if (!value?.post_id || !['A', 'B', 'C'].includes(value.variation)) return;
    await runSharePipeline(
      { config, db, shareClient, client, logger, ...(fetchFile ? { fetchFile } : {}) },
      {
        postId: value.post_id,
        variation: value.variation,
        customText: null,
        userId: body.user.id,
        channelId: body.channel?.id || null,
      }
    );
  });

  app.action('edit_share_custom', async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      let value;
      try {
        value = JSON.parse(action.value);
      } catch {
        logger.error(`Unparseable custom button value: ${action.value}`);
        return;
      }
      const post = await db('posts').where({ id: value.post_id }).first();
      if (!post) {
        await postEphemeralSafely(
          { client, logger },
          body.channel?.id,
          body.user.id,
          '😕 This post no longer exists.'
        );
        return;
      }
      // Same authoritative check the pipeline runs (§2.3): don't let the
      // user compose a whole custom caption only to lose it to C12 at
      // submit time because the card's buttons outlived the window.
      if (isPostExpired(post)) {
        await postEphemeralSafely({ client, logger }, body.channel?.id, body.user.id, copy.C12);
        return;
      }
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCustomShareModal({ post, channelId: body.channel?.id || null }),
      });
    } catch (err) {
      // DB or views.open failure — the user clicked and must hear something.
      logger.error('edit_share_custom failed', err);
      await postEphemeralSafely(
        { client, logger },
        body.channel?.id,
        body.user.id,
        '😕 Could not open the editor — please try again.'
      );
    }
  });

  app.view(CUSTOM_MODAL_CALLBACK_ID, async ({ ack, body, view, client, logger }) => {
    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      // metadata is ours; if malformed, validation below still acks cleanly
    }

    const raw = view.state.values.custom_caption?.value?.value;
    const text = raw && raw.trim() ? raw.trim() : null;
    if (!text) {
      await ack({ response_action: 'errors', errors: { custom_caption: 'A caption is required.' } });
      return;
    }
    if (text.length > CAPTION_MAX) {
      await ack({
        response_action: 'errors',
        errors: {
          custom_caption: `Captions can be at most ${CAPTION_MAX} characters (LinkedIn's limit).`,
        },
      });
      return;
    }

    // The destination URL is always appended to the commentary (§4 — lets
    // LinkedIn's own crawler unfurl it), so caption + separator + URL must
    // fit the same limit, regardless of whether an image is attached
    // (shared rule: src/linkedin/limits.js). The URL comes from
    // private_metadata (stashed at modal-open time) so this pre-ack path
    // stays free of DB reads — everything that needs the DB runs after
    // ack(), outside Slack's 3-second window.
    const budgetError = captionWithUrlError(text, meta.destination_url);
    if (budgetError) {
      await ack({ response_action: 'errors', errors: { custom_caption: budgetError } });
      return;
    }
    await ack();

    if (!meta.post_id) return; // metadata is ours; malformed means nothing actionable
    // The pipeline re-reads the post itself and already handles every
    // outcome a lookup here would: a deleted post ("no longer exists"), an
    // expired one (C12), and a DB failure (generic ephemeral).
    await runSharePipeline(
      { config, db, shareClient, client, logger, ...(fetchFile ? { fetchFile } : {}) },
      {
        postId: meta.post_id,
        variation: 'CUSTOM',
        customText: text,
        userId: body.user.id,
        channelId: meta.channel_id || null,
      }
    );
  });
}

module.exports = {
  registerShareHandlers,
  runSharePipeline,
  drainSharePipelines,
  PENDING_STALE_MS,
  buildCustomShareModal,
  CUSTOM_MODAL_CALLBACK_ID,
};
