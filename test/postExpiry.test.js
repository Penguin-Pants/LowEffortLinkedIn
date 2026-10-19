const { loadConfig } = require('../src/config');
const { runPostExpiry, startPostExpiryJob } = require('../src/jobs/postExpiry');

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ...extra,
  });
}

const NOW = new Date('2026-07-02T09:00:00Z');

function duePost(id, overrides = {}) {
  return {
    id,
    destination_url: 'https://example.com/blog',
    caption_a: 'Caption A',
    caption_b: null,
    caption_c: null,
    image_slack_file_id: null,
    created_by_slack_id: 'U_MARKETER',
    slack_channel_id: 'C_ADV',
    slack_message_ts: '1719900000.000100',
    expires_at: new Date(NOW.getTime() - 60_000),
    expired_at: null,
    ...overrides,
  };
}

// The due-scan query shape itself is exercised against real Postgres in the
// smoke run; unit tests stub the due-list and verify the update/stamp
// behavior around it, same split as expiryReminder.test.js.
function fakeDb({ duePosts, successCounts = {}, cardsByPost = {} } = {}) {
  const postUpdates = [];
  const db = (table) => {
    if (table === 'posts') {
      const b = {
        whereNotNull: () => b,
        whereNull: () => b,
        where: () => b,
        update: async (patch) => {
          postUpdates.push(patch);
          return 1;
        },
        then: (resolve, reject) => Promise.resolve(duePosts).then(resolve, reject),
      };
      return b;
    }
    if (table === 'post_cards') {
      return {
        where: (cond) => ({
          // Default to a single card mirroring the post's primary columns;
          // override via cardsByPost to exercise multi-channel fan-out.
          select: async () => {
            if (cardsByPost[cond.post_id]) return cardsByPost[cond.post_id];
            const p = (duePosts || []).find((d) => d.id === cond.post_id);
            return p && p.slack_channel_id && p.slack_message_ts
              ? [{ slack_channel_id: p.slack_channel_id, slack_message_ts: p.slack_message_ts }]
              : [];
          },
        }),
      };
    }
    if (table === 'shares') {
      return {
        where: (cond) => ({
          count: async () => [{ count: String(successCounts[cond.post_id] ?? 0) }],
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  db.fn = { now: () => 'NOW' };
  return { db, postUpdates };
}

// Mirrors @slack/logger's real Logger interface (no .log) — see
// test/share.test.js's quietLogger for why this matters: a mock with an
// extra .log stub masked the exact bug that broke production once already.
const quiet = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('runPostExpiry', () => {
  test('rebuilds the card without buttons, preserves the counter, then stamps', async () => {
    const { db, postUpdates } = fakeDb({
      duePosts: [duePost('post-1')],
      successCounts: { 'post-1': 5 },
    });
    const slackClient = { chat: { update: jest.fn().mockResolvedValue({ ok: true }) } };

    const result = await runPostExpiry({ db, slackClient, logger: quiet }, NOW);

    expect(result).toEqual({ due: 1, closed: 1 });
    const call = slackClient.chat.update.mock.calls[0][0];
    expect(call.channel).toBe('C_ADV');
    expect(call.ts).toBe('1719900000.000100');
    expect(call.blocks.some((b) => b.type === 'actions')).toBe(false);
    const context = call.blocks[call.blocks.length - 1];
    expect(context.elements[0].text).toContain('✅ 5 shares');
    expect(context.elements[0].text).toContain('⏰ Sharing closed');

    expect(postUpdates).toEqual([expect.objectContaining({ expired_at: 'NOW' })]);
  });

  test('closes every card of a multi-channel post, then stamps once', async () => {
    const { db, postUpdates } = fakeDb({
      duePosts: [duePost('post-1')],
      successCounts: { 'post-1': 3 },
      cardsByPost: {
        'post-1': [
          { slack_channel_id: 'C_ONE', slack_message_ts: '1.1' },
          { slack_channel_id: 'C_TWO', slack_message_ts: '2.2' },
        ],
      },
    });
    const slackClient = { chat: { update: jest.fn().mockResolvedValue({ ok: true }) } };

    const result = await runPostExpiry({ db, slackClient, logger: quiet }, NOW);

    expect(result).toEqual({ due: 1, closed: 1 });
    expect(slackClient.chat.update).toHaveBeenCalledTimes(2);
    expect(slackClient.chat.update.mock.calls.map((c) => c[0].channel)).toEqual(['C_ONE', 'C_TWO']);
    // Stamped exactly once — after all cards closed.
    expect(postUpdates).toEqual([expect.objectContaining({ expired_at: 'NOW' })]);
  });

  test('a multi-channel post is not stamped if one of its cards fails to close', async () => {
    const { db, postUpdates } = fakeDb({
      duePosts: [duePost('post-1')],
      cardsByPost: {
        'post-1': [
          { slack_channel_id: 'C_ONE', slack_message_ts: '1.1' },
          { slack_channel_id: 'C_TWO', slack_message_ts: '2.2' },
        ],
      },
    });
    const slackClient = {
      chat: {
        update: jest
          .fn()
          .mockResolvedValueOnce({ ok: true })
          .mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'internal_error' } })),
      },
    };

    const result = await runPostExpiry({ db, slackClient, logger: quiet }, NOW);

    expect(result).toEqual({ due: 1, closed: 0 });
    expect(slackClient.chat.update).toHaveBeenCalledTimes(2); // both attempted
    expect(postUpdates).toHaveLength(0); // not stamped — retries next run
  });

  test.each([
    'message_not_found',
    'channel_not_found',
    'invalid_channel_id',
    'cant_update_message',
    'edit_window_closed',
    'is_inactive',
  ])('a card that can never be updated (%s) counts as closed, so the post is not retried forever', async (code) => {
    const { db, postUpdates } = fakeDb({
      duePosts: [duePost('post-1')],
      cardsByPost: {
        'post-1': [
          { slack_channel_id: 'C_GONE', slack_message_ts: '1.1' },
          { slack_channel_id: 'C_OK', slack_message_ts: '2.2' },
        ],
      },
    });
    const slackClient = {
      chat: {
        update: jest
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: code } }))
          .mockResolvedValueOnce({ ok: true }),
      },
    };
    const logger = { ...quiet, warn: jest.fn(), error: jest.fn() };

    const result = await runPostExpiry({ db, slackClient, logger }, NOW);

    expect(result).toEqual({ due: 1, closed: 1 });
    expect(postUpdates).toEqual([expect.objectContaining({ expired_at: 'NOW' })]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('does nothing when nothing is due', async () => {
    const { db, postUpdates } = fakeDb({ duePosts: [] });
    const slackClient = { chat: { update: jest.fn() } };
    const result = await runPostExpiry({ db, slackClient, logger: quiet }, NOW);
    expect(result).toEqual({ due: 0, closed: 0 });
    expect(slackClient.chat.update).not.toHaveBeenCalled();
    expect(postUpdates).toHaveLength(0);
  });

  test('a failed card update leaves the stamp unwritten and continues with other posts', async () => {
    const { db, postUpdates } = fakeDb({
      duePosts: [duePost('post-fail'), duePost('post-ok')],
    });
    const slackClient = {
      chat: {
        update: jest
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'internal_error' } }))
          .mockResolvedValueOnce({ ok: true }),
      },
    };

    const result = await runPostExpiry({ db, slackClient, logger: quiet }, NOW);

    expect(result).toEqual({ due: 2, closed: 1 });
    expect(slackClient.chat.update).toHaveBeenCalledTimes(2);
    expect(postUpdates).toHaveLength(1); // only post-ok stamped; post-fail retries next run
  });
});

describe('startPostExpiryJob', () => {
  test('schedules the configured cron in UTC and returns the task', () => {
    const task = { stop: jest.fn() };
    const cronLib = { validate: jest.fn().mockReturnValue(true), schedule: jest.fn(() => task) };
    const returned = startPostExpiryJob(
      { config: testConfig(), db: {}, logger: quiet },
      { cronLib, slackClient: { chat: {} } }
    );
    expect(returned).toBe(task);
    expect(cronLib.schedule).toHaveBeenCalledWith('*/15 * * * *', expect.any(Function), {
      timezone: 'Etc/UTC',
    });
  });

  test('honors POST_EXPIRY_CRON and fails fast on an invalid expression', () => {
    const cronLib = { validate: (expr) => expr === '*/5 * * * *', schedule: jest.fn(() => ({})) };
    startPostExpiryJob(
      { config: testConfig({ POST_EXPIRY_CRON: '*/5 * * * *' }), db: {}, logger: quiet },
      { cronLib, slackClient: { chat: {} } }
    );
    expect(cronLib.schedule).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function), {
      timezone: 'Etc/UTC',
    });

    expect(() =>
      startPostExpiryJob(
        { config: testConfig({ POST_EXPIRY_CRON: 'not-a-cron' }), db: {}, logger: quiet },
        { cronLib, slackClient: { chat: {} } }
      )
    ).toThrow(/POST_EXPIRY_CRON/);
  });

  test('the real node-cron accepts the default expression', () => {
    const cron = require('node-cron');
    expect(cron.validate(testConfig().postExpiryCron)).toBe(true);
  });
});
