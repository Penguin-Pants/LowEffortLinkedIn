// Post sharing expiry — new feature (was future/out-of-scope in PLAN.md
// §13). Once a post's sharing window (set at /create-post time from the
// marketer's chosen hours, or DEFAULT_POST_EXPIRY_HOURS) has passed, this
// job strips the Share/Edit buttons off the card. The message and its share
// counter stay visible — only future sharing is closed off. The share
// pipeline (src/handlers/share.js) independently rejects expired posts too,
// so a click landing in the gap between cron runs is still blocked; this job
// is what makes that visible on the card itself.

const { buildPostCard, postCardText } = require('../blocks/postCard');
const { loadPostCards } = require('../db/postCards');
const { startCronJob } = require('./cronJob');

// chat.update errors that mean this card can never be updated again — it was
// deleted, its channel is gone or archived, or the workspace's edit window
// closed (https://docs.slack.dev/reference/methods/chat.update). Retrying
// them would repeat the same error every run, forever. Such a card counts as
// closed: the share pipeline rejects clicks on expired posts on its own.
// Auth, rate-limit and server errors are left out — they can recover.
const UNUPDATABLE_CARD_ERRORS = new Set([
  'message_not_found',
  'channel_not_found',
  'invalid_channel_id',
  'cant_update_message',
  'edit_window_closed',
  'is_inactive',
]);

// Due = past its window, still has a live card, and hasn't been closed out
// yet (expired_at is the idempotency stamp — set only after a successful
// chat.update, mirroring the token-reminder job's pattern).
function findPostsToExpire(db, now = new Date()) {
  return db('posts')
    .whereNotNull('expires_at')
    .whereNull('expired_at')
    .where('expires_at', '<=', now)
    .whereNotNull('slack_channel_id')
    .whereNotNull('slack_message_ts');
}

// One pass of the job. A post can have been broadcast to several channels, so
// every card is stripped of its buttons. The stamp is written only after all
// of a post's cards are closed (updated, or permanently un-updatable), so a
// recoverable failure retries the whole post on the next run (chat.update is
// idempotent); one post's failure never blocks the rest.
async function runPostExpiry({ db, slackClient, logger = console }, now = new Date()) {
  const due = await findPostsToExpire(db, now);
  let closed = 0;
  for (const post of due) {
    try {
      const [{ count }] = await db('shares')
        .where({ post_id: post.id, status: 'success' })
        .count();
      const cards = await loadPostCards(db, post);
      // expired_at is only a local render hint here — the DB write below is
      // what actually makes the state durable.
      const blocks = buildPostCard({ post: { ...post, expired_at: now }, shareCount: Number(count) });
      let allClosed = cards.length > 0;
      for (const card of cards) {
        try {
          await slackClient.chat.update({
            channel: card.slack_channel_id,
            ts: card.slack_message_ts,
            text: postCardText(post),
            blocks,
          });
        } catch (err) {
          const reason = err.data?.error || err.message;
          if (UNUPDATABLE_CARD_ERRORS.has(err.data?.error)) {
            logger.warn(
              `Post expiry: card for post ${post.id} in ${card.slack_channel_id} can't be updated ` +
                `(${reason}) — treating it as closed`
            );
            continue;
          }
          allClosed = false;
          logger.error(
            `Post expiry close failed for post ${post.id} card ${card.slack_channel_id}: ${reason}`
          );
        }
      }
      if (allClosed) {
        await db('posts').where({ id: post.id }).update({ expired_at: db.fn.now() });
        closed += 1;
      }
    } catch (err) {
      logger.error(
        `Post expiry close failed for post ${post.id}: ${err.data?.error || err.message}`
      );
    }
  }
  // .info(), not .log() — logger defaults to console, but the real Bolt
  // Logger (no .log) works here too if a future change ever passes it in.
  if (due.length > 0) logger.info(`Post expiry: ${closed}/${due.length} cards closed`);
  return { due: due.length, closed };
}

// Schedules the frequent run (config.postExpiryCron, UTC) — expiry windows
// are hours-scale, so this needs finer granularity than the daily token
// reminder. Returns the task so the caller can stop() it on shutdown.
function startPostExpiryJob({ config, db, logger = console }, overrides = {}) {
  return startCronJob({ config, db, logger }, overrides, {
    envVarName: 'POST_EXPIRY_CRON',
    cronExpression: config.postExpiryCron,
    run: runPostExpiry,
    label: 'Post expiry',
  });
}

module.exports = { findPostsToExpire, runPostExpiry, startPostExpiryJob };
