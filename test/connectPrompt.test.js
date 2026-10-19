const { loadConfig } = require('../src/config');
const { verifyToken } = require('../src/crypto/signedToken');
const {
  buildConnectUrl,
  sendConnectPrompt,
  getConnection,
  clearConnection,
} = require('../src/slack/connectPrompt');

const STATE_SECRET = 'state-secret';

function testConfig() {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: STATE_SECRET,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
  });
}

describe('buildConnectUrl', () => {
  test('points at /auth/linkedin with a verifiable signed connect token', () => {
    const url = new URL(buildConnectUrl(testConfig(), 'U777'));
    expect(url.origin).toBe('https://example.up.railway.app');
    expect(url.pathname).toBe('/auth/linkedin');
    const payload = verifyToken(url.searchParams.get('token'), STATE_SECRET, 'connect');
    expect(payload.slack_user_id).toBe('U777');
  });
});

describe('sendConnectPrompt', () => {
  test('posts an ephemeral C1 with a url button in the origin channel', async () => {
    const client = { chat: { postEphemeral: jest.fn().mockResolvedValue({ ok: true }) } };
    await sendConnectPrompt(
      { client, config: testConfig() },
      { channelId: 'C42', userId: 'U777' }
    );
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    const call = client.chat.postEphemeral.mock.calls[0][0];
    expect(call.channel).toBe('C42');
    expect(call.user).toBe('U777');
    expect(call.text).toContain('Connect your LinkedIn');
    const button = call.blocks.find((b) => b.type === 'actions').elements[0];
    expect(button.url).toContain('/auth/linkedin?token=');
  });
});

describe('getConnection', () => {
  const dbReturning = (row) => () => ({
    where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(row) }),
  });
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const connected = {
    slack_user_id: 'U777',
    linkedin_access_token: 'encrypted',
    linkedin_person_id: 'abc',
    token_expires_at: future,
  };

  test('returns the row for a live connection', async () => {
    await expect(getConnection(dbReturning(connected), 'U777')).resolves.toEqual(connected);
  });

  test('returns null when there is no row', async () => {
    await expect(getConnection(dbReturning(undefined), 'U777')).resolves.toBeNull();
  });

  test('returns null when the token was cleared (post-/disconnect)', async () => {
    await expect(
      getConnection(dbReturning({ ...connected, linkedin_access_token: null }), 'U777')
    ).resolves.toBeNull();
  });

  test('returns null when the token has expired', async () => {
    await expect(
      getConnection(dbReturning({ ...connected, token_expires_at: new Date(0) }), 'U777')
    ).resolves.toBeNull();
  });
});

describe('clearConnection', () => {
  test("nulls the person's LinkedIn token, identity, expiry and reminder stamp", async () => {
    const calls = [];
    const db = (table) => ({
      where: (cond) => ({
        update: async (patch) => {
          calls.push({ table, cond, patch });
          return 1;
        },
      }),
    });
    db.fn = { now: () => 'NOW' };
    await clearConnection(db, 'U777');
    expect(calls).toEqual([
      {
        table: 'users',
        cond: { slack_user_id: 'U777' },
        patch: {
          linkedin_access_token: null,
          linkedin_person_id: null,
          token_expires_at: null,
          expiry_reminder_sent_at: null,
          updated_at: 'NOW',
        },
      },
    ]);
  });
});
