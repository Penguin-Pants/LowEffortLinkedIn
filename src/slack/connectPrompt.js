// "Connect your LinkedIn" prompt (C1) — PLAN.md §2.2.
// The connect link carries a signed slack_id token, only ever minted here in
// response to a signature-verified Slack interaction, so /auth/linkedin can't
// be used to bind a LinkedIn account to an arbitrary coworker's Slack ID.

const copy = require('../copy');
const { signToken } = require('../crypto/signedToken');

const CONNECT_LINK_TTL_SECONDS = 15 * 60;
const CONNECT_BUTTON_ACTION_ID = 'connect_linkedin';

// The 15-minute default fits the ephemeral C1 prompt (clicked in the moment).
// Callers whose button sits in an inbox — the Phase 6 reminder DM — pass a
// longer TTL; the token still only lets the recipient bind THEIR OWN Slack ID.
function buildConnectUrl(config, slackUserId, ttlSeconds = CONNECT_LINK_TTL_SECONDS) {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'connect' },
    config.oauthStateSecret,
    ttlSeconds
  );
  return `${config.publicBaseUrl}/auth/linkedin?token=${encodeURIComponent(token)}`;
}

// Ephemeral in the channel where the user clicked (§2.2 step 1). `text` is
// used when blocks are absent/unsupported and doubles as the notification.
async function sendConnectPrompt({ client, config }, { channelId, userId }) {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: copy.C1,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: copy.C1 } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Connect LinkedIn' },
            url: buildConnectUrl(config, userId),
            action_id: CONNECT_BUTTON_ACTION_ID,
          },
        ],
      },
    ],
  });
}

// url buttons still emit a block_actions payload when clicked; Slack shows a
// warning icon on the message unless it's acked. The browser opens the URL
// regardless — nothing else to do here.
function registerConnectPromptAction(app) {
  app.action(CONNECT_BUTTON_ACTION_ID, async ({ ack }) => {
    await ack();
  });
}

// Trigger points 1 & 2 from §2.2: returns the users row only when it holds a
// non-expired LinkedIn connection; null means "run the connect flow". Trigger
// point 3 (LinkedIn 401 at share time) is handled by the Phase 4 share
// pipeline calling sendConnectPrompt directly.
async function getConnection(db, slackUserId) {
  const row = await db('users').where({ slack_user_id: slackUserId }).first();
  if (!row || !row.linkedin_access_token || !row.linkedin_person_id) return null;
  if (!row.token_expires_at || new Date(row.token_expires_at) <= new Date()) return null;
  return row;
}

// Forget the person's LinkedIn connection (token, identity, expiry and the
// reminder stamp) but keep the users row and its share history. Used by
// /disconnect and by the share pipeline on a LinkedIn 401.
async function clearConnection(db, slackUserId) {
  await db('users').where({ slack_user_id: slackUserId }).update({
    linkedin_access_token: null,
    linkedin_person_id: null,
    token_expires_at: null,
    expiry_reminder_sent_at: null,
    updated_at: db.fn.now(),
  });
}

module.exports = {
  buildConnectUrl,
  sendConnectPrompt,
  registerConnectPromptAction,
  getConnection,
  clearConnection,
  CONNECT_LINK_TTL_SECONDS,
};
