// Block Kit card broadcast to the advocacy channel — PLAN.md §2.1.
// Rebuilt (with a fresh shareCount) by the Phase 4 counter update, so this is
// the single source of truth for the card's layout.

const { escapeMrkdwn } = require('../mrkdwn');

const VARIATION_LABELS = ['A', 'B', 'C'];

function captionsOf(post) {
  return VARIATION_LABELS.map((label) => [label, post[`caption_${label.toLowerCase()}`]]).filter(
    ([, text]) => text && text.trim()
  );
}

// The post's sharing window has passed (the expiry job may not have closed
// the card yet). Shared by the share pipeline and the custom-share button so
// the rule can't drift.
function isPostExpired(post, now = new Date()) {
  return Boolean(post.expires_at) && new Date(post.expires_at) <= now;
}

// Notification/fallback `text` for every chat.postMessage/chat.update of a card.
function postCardText(post) {
  return `New post ready to share: ${post.destination_url}`;
}

function buildPostCard({ post, shareCount }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📣 *New post ready to share!*\n${escapeMrkdwn(post.destination_url)}`,
      },
    },
  ];

  if (post.image_slack_file_id) {
    blocks.push({
      type: 'image',
      slack_file: { id: post.image_slack_file_id },
      alt_text: 'Post image',
    });
  }

  const captions = captionsOf(post);
  for (const [label, text] of captions) {
    // Label lives in its own context block: a 3000-char caption plus a label
    // would overflow a section block's 3000-char text limit.
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Variation ${label}*` }],
    });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(text) } });
  }

  // Sharing expiry: once the post-expiry job has stamped expired_at, the
  // buttons are removed entirely — the message and its counter stay visible,
  // only future sharing is closed off.
  const isExpired = Boolean(post.expired_at);
  if (!isExpired) {
    const buttons = captions.map(([label]) => ({
      type: 'button',
      text: { type: 'plain_text', text: `Share Variation ${label}` },
      action_id: `share_variation_${label.toLowerCase()}`,
      value: JSON.stringify({ post_id: post.id, variation: label }),
    }));
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Edit & Share Custom' },
      action_id: 'edit_share_custom',
      value: JSON.stringify({ post_id: post.id }),
    });
    blocks.push({ type: 'actions', elements: buttons });
  }

  const createdAt = post.created_at ? new Date(post.created_at) : new Date();
  const unix = Math.floor(createdAt.getTime() / 1000);
  const isoDay = createdAt.toISOString().slice(0, 10);

  let expirySegment = '';
  if (isExpired) {
    expirySegment = ' · ⏰ Sharing closed';
  } else if (post.expires_at) {
    const expiresAt = new Date(post.expires_at);
    const expUnix = Math.floor(expiresAt.getTime() / 1000);
    expirySegment = ` · Sharing closes <!date^${expUnix}^{date_short} {time}|${expiresAt.toISOString()}>`;
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `Posted by <@${post.created_by_slack_id}> · ` +
          `<!date^${unix}^{date_short}|${isoDay}> · ✅ ${shareCount} share${shareCount === 1 ? '' : 's'}` +
          expirySegment,
      },
    ],
  });

  return blocks;
}

module.exports = { buildPostCard, isPostExpired, postCardText };
