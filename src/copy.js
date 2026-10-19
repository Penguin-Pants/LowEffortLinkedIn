// Final user-facing copy — PLAN.md §8. IDs match the plan's copy table.
// Strings with runtime substitutions are functions; the rest are constants.

const { escapeMrkdwn } = require('./mrkdwn');

module.exports = {
  C1: '🔗 *Connect your LinkedIn to start sharing!* It takes about 30 seconds and you only do it once.',
  C2: "✅ *LinkedIn connected!* You're all set — head back to the post and hit Share. 🎉",
  C3: '🎉 *Shared to your LinkedIn!* Nice one — your network thanks you.',
  C4: "👀 You've already shared this post — no double-dipping! Keep an eye out for the next one.",
  C5: (days) =>
    `⏰ *Heads up!* Your LinkedIn connection expires in ${days} day${days === 1 ? '' : 's'}. ` +
    'Reconnect now (takes 30 seconds) so one-click sharing keeps working:',
  // The error text comes from LinkedIn's API — external input. Escape mrkdwn
  // and strip backticks so it can't break out of the inline-code span.
  C6: (error, marketerMention) =>
    `😕 That didn't go through. LinkedIn said: \`${escapeMrkdwn(error).replace(/`/g, "'")}\`. ` +
    `Give it another try in a minute — if it keeps happening, ping ${marketerMention}.`,
  C7:
    '👋 *LinkedIn disconnected.* Your token is deleted; your past share history is kept for the ' +
    'leaderboard. Run `/disconnect all` if you want that erased too. Reconnect anytime by ' +
    'clicking any Share button.',
  C8:
    '🧹 *All gone.* Your LinkedIn connection and your entire share history have been erased. ' +
    'Reconnect anytime by clicking any Share button.',
  C9: (channelMention) =>
    `📣 *Your post is live in ${channelMention}!* You'll see the share counter tick up on the card.`,
  C10: (marketerMention) =>
    `🚫 Sorry, only the marketing team can create posts. Think you should have access? Ask ${marketerMention}.`,
  C11_HEADER: (days, total) =>
    `🏆 *Top sharers, last ${days} days* — ${total} share${total === 1 ? '' : 's'} total`,
  C11_EMPTY: 'No shares in this window yet — be the first! 👀',
  C12: '⏰ Sharing for this post has closed. Keep an eye out for the next one!',
  C13: "⏳ Your share of this post is already on its way — hang tight, you'll get a confirmation here.",
  C14:
    "⚠️ We couldn't confirm whether your last share of this post reached LinkedIn. " +
    "Check your LinkedIn profile first — if it isn't there, click Share again.",
};
