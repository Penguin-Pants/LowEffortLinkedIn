// /disconnect — self-service disconnect & erasure (PLAN.md §2.4).
// No args: clear the LinkedIn connection, keep share history (C7).
// "all": delete the users row entirely — the shares FK cascades, erasing
// share history too (C8). Both variants are idempotent: running them with
// nothing to delete gives the same friendly response.

const copy = require('../copy');
const { escapeMrkdwn } = require('../mrkdwn');
const { clearConnection } = require('../slack/connectPrompt');

function registerDisconnect(app, { db }) {
  app.command('/disconnect', async ({ command, ack, respond, logger }) => {
    await ack();
    const arg = (command.text || '').trim().toLowerCase();
    const eraseAll = arg === 'all';
    // A typo like "/disconnect al" must not silently do the lesser action —
    // ask instead of guessing.
    if (arg && !eraseAll) {
      // arg is user input rendered in mrkdwn — escape it and keep it short.
      const shown = escapeMrkdwn(arg.slice(0, 30)).replace(/`/g, "'");
      await respond({
        response_type: 'ephemeral',
        text:
          `🤔 I didn't recognize \`${shown}\`. Use \`/disconnect\` to remove your LinkedIn ` +
          'connection (share history kept), or `/disconnect all` to erase your share history too.',
      });
      return;
    }
    try {
      if (eraseAll) {
        // ON DELETE CASCADE on shares.slack_user_id erases history with the row.
        await db('users').where({ slack_user_id: command.user_id }).del();
      } else {
        await clearConnection(db, command.user_id);
      }
      await respond({ response_type: 'ephemeral', text: eraseAll ? copy.C8 : copy.C7 });
    } catch (err) {
      logger.error('/disconnect failed', err);
      await respond({
        response_type: 'ephemeral',
        text: '😕 Something went wrong — please try `/disconnect` again.',
      });
    }
  });
}

module.exports = { registerDisconnect };
