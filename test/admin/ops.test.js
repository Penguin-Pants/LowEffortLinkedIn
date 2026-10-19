const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { signToken } = require('../../src/crypto/signedToken');
const { fakeAdminDb } = require('./fakeAdminDb');
const { probeDb, probeSlack, probeLinkedin } = require('../../src/admin/ops');

const ADMIN_SESSION_SECRET = 'admin-session-secret';

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
    ADMIN_UI_ENABLED: 'true',
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    ADMIN_SESSION_SECRET,
    ...extra,
  });
}

function sessionCookie(slackUserId = 'U111') {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'admin_session' },
    ADMIN_SESSION_SECRET,
    12 * 60 * 60
  );
  return `admin_session=${encodeURIComponent(token)}`;
}

describe('probeDb / probeSlack / probeLinkedin', () => {
  test('probeDb reports up/down from the raw().timeout() probe', async () => {
    const up = { raw: () => ({ timeout: async () => [] }) };
    const down = { raw: () => ({ timeout: async () => { throw new Error('no route to host'); } }) };
    await expect(probeDb(up)).resolves.toBe('up');
    await expect(probeDb(down)).resolves.toBe('down');
  });

  test('probeSlack reports up/down from auth.test()', async () => {
    const up = { auth: { test: async () => ({ ok: true }) } };
    const down = { auth: { test: async () => { throw new Error('invalid_auth'); } } };
    await expect(probeSlack(up)).resolves.toBe('up');
    await expect(probeSlack(down)).resolves.toBe('down');
  });

  test('probeLinkedin flags a LinkedIn-Version near or past its sunset', () => {
    const config = { linkedinMockMode: false, linkedinClientId: 'a', linkedinClientSecret: 'b' };
    const now = new Date('2026-10-19T00:00:00Z');
    expect(probeLinkedin({ ...config, linkedinVersion: '202506' }, now)).toBe(
      'configured (API version 202506 is unreleased or near/past sunset)'
    );
    // Mock mode makes no LinkedIn calls, so the version is irrelevant there.
    expect(probeLinkedin({ linkedinMockMode: true, linkedinVersion: '202506' }, now)).toBe('mock');
  });

  test('probeLinkedin reports mock/configured/not-configured', () => {
    expect(probeLinkedin({ linkedinMockMode: true })).toBe('mock');
    expect(
      probeLinkedin({
        linkedinMockMode: false,
        linkedinClientId: 'a',
        linkedinClientSecret: 'b',
        linkedinVersion: '202610',
      }, new Date('2026-10-19T00:00:00Z'))
    ).toBe('configured');
    expect(probeLinkedin({ linkedinMockMode: false, linkedinClientId: null, linkedinClientSecret: null })).toBe(
      'not configured'
    );
  });
});

describe('GET /admin/api/health', () => {
  function buildApp(slackClient) {
    const { db } = fakeAdminDb();
    const { receiver } = createServer(testConfig(), db, {
      authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
      logLevel: 'error',
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
      slackClient,
    });
    return request(receiver.app);
  }

  test('401s without a session', async () => {
    const res = await buildApp({ auth: { test: async () => ({ ok: true }) } }).get('/admin/api/health');
    expect(res.status).toBe(401);
  });

  test('reports db/slack/linkedin/environment status for an authenticated marketer', async () => {
    const slackClient = { auth: { test: async () => ({ ok: true }) } };
    const res = await buildApp(slackClient).get('/admin/api/health').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ db: 'up', slack: 'up', linkedin: 'mock', environment: 'development' });
  });

  test('environment prefers RAILWAY_ENVIRONMENT_NAME over config.nodeEnv when set (Finding F4)', async () => {
    const slackClient = { auth: { test: async () => ({ ok: true }) } };
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    try {
      const res = await buildApp(slackClient).get('/admin/api/health').set('Cookie', sessionCookie());
      expect(res.body.environment).toBe('production');
    } finally {
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
    }
  });

  test('reports slack: down when the auth.test call fails', async () => {
    const slackClient = { auth: { test: async () => { throw new Error('invalid_auth'); } } };
    const res = await buildApp(slackClient).get('/admin/api/health').set('Cookie', sessionCookie());
    expect(res.body.slack).toBe('down');
  });
});

describe('POST /admin/api/restart', () => {
  test('401s without a session', async () => {
    const { db } = fakeAdminDb();
    const { receiver } = createServer(testConfig(), db, {
      authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
      logLevel: 'error',
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    });
    const res = await request(receiver.app).post('/admin/api/restart');
    expect(res.status).toBe(401);
  });

  test('responds with a disclosed-outage message, then hands off to the graceful SIGTERM path (F3)', async () => {
    // The route signals SIGTERM (so index.js's shutdown handler drains
    // in-flight work) instead of calling process.exit() cold.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    const { db } = fakeAdminDb();
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    const { receiver } = createServer(testConfig(), db, {
      authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
      logLevel: 'error',
      logger,
    });
    const res = await request(receiver.app).post('/admin/api/restart').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/briefly unavailable/);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('U111'));

    // The signal fires on the response's 'finish' event — by the time
    // supertest has the response, it must have been sent exactly once.
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });
});
