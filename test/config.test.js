const { loadConfig, isLinkedinVersionStale, DEFAULT_LINKEDIN_API_VERSION } = require('../src/config');

// 32 bytes, base64
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

function validEnv(overrides = {}) {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111,U222',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: VALID_KEY,
    PUBLIC_BASE_URL: 'https://example.up.railway.app/',
    LINKEDIN_MOCK_MODE: 'true',
    ...overrides,
  };
}

describe('loadConfig', () => {
  test('parses a valid environment', () => {
    const config = loadConfig(validEnv());
    expect(config.marketerSlackIds).toEqual(['U111', 'U222']);
    expect(config.advocacyChannelIds).toEqual(['C123']);
    expect(config.tokenEncryptionKey.length).toBe(32);
    expect(config.linkedinMockMode).toBe(true);
    expect(config.publicBaseUrl).toBe('https://example.up.railway.app'); // trailing slash stripped
    expect(config.port).toBe(3000);
  });

  test('fails fast when a required variable is missing', () => {
    expect(() => loadConfig(validEnv({ SLACK_BOT_TOKEN: '' }))).toThrow(/SLACK_BOT_TOKEN/);
  });

  test('fails fast when MARKETER_SLACK_IDS is only whitespace/commas', () => {
    expect(() => loadConfig(validEnv({ MARKETER_SLACK_IDS: ' , ,' }))).toThrow(
      /MARKETER_SLACK_IDS/
    );
  });

  test('parses multiple comma-separated advocacy channel IDs', () => {
    const config = loadConfig(validEnv({ ADVOCACY_CHANNEL_ID: 'C123, C456, C789' }));
    expect(config.advocacyChannelIds).toEqual(['C123', 'C456', 'C789']);
  });

  test('fails fast when ADVOCACY_CHANNEL_ID is only whitespace/commas', () => {
    expect(() => loadConfig(validEnv({ ADVOCACY_CHANNEL_ID: ' , ,' }))).toThrow(
      /ADVOCACY_CHANNEL_ID/
    );
  });

  test('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig(validEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }))
    ).toThrow(/32 bytes/);
  });

  test('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => loadConfig(validEnv({ PORT: 'abc' }))).toThrow(/PORT/);
    expect(() => loadConfig(validEnv({ PORT: '70000' }))).toThrow(/PORT/);
    expect(loadConfig(validEnv({ PORT: '8080' })).port).toBe(8080);
  });

  test('requires LinkedIn credentials only when mock mode is off', () => {
    expect(() => loadConfig(validEnv({ LINKEDIN_MOCK_MODE: 'false' }))).toThrow(
      /LINKEDIN_CLIENT_ID/
    );
    const config = loadConfig(
      validEnv({
        LINKEDIN_MOCK_MODE: 'false',
        LINKEDIN_CLIENT_ID: 'cid',
        LINKEDIN_CLIENT_SECRET: 'csecret',
        LINKEDIN_REDIRECT_URI: 'https://example.up.railway.app/auth/linkedin/callback',
      })
    );
    expect(config.linkedinMockMode).toBe(false);
    expect(config.linkedinClientId).toBe('cid');
  });

  test('defaults DEFAULT_POST_EXPIRY_HOURS to 8 and POST_EXPIRY_CRON to every 15 minutes', () => {
    const config = loadConfig(validEnv());
    expect(config.defaultPostExpiryHours).toBe(8);
    expect(config.postExpiryCron).toBe('*/15 * * * *');
  });

  test('accepts a custom DEFAULT_POST_EXPIRY_HOURS', () => {
    const config = loadConfig(validEnv({ DEFAULT_POST_EXPIRY_HOURS: '24' }));
    expect(config.defaultPostExpiryHours).toBe(24);
  });

  test('rejects a non-numeric, zero, negative, or out-of-range DEFAULT_POST_EXPIRY_HOURS', () => {
    for (const bad of ['soon', '0', '-3', '721']) {
      expect(() => loadConfig(validEnv({ DEFAULT_POST_EXPIRY_HOURS: bad }))).toThrow(
        /DEFAULT_POST_EXPIRY_HOURS/
      );
    }
  });

  test('admin UI is off by default and its secrets are optional', () => {
    const config = loadConfig(validEnv());
    expect(config.adminUiEnabled).toBe(false);
    expect(config.slackClientId).toBeNull();
    expect(config.adminSessionSecret).toBeNull();
  });

  test('requires Slack OpenID + session secrets only when ADMIN_UI_ENABLED is true', () => {
    expect(() => loadConfig(validEnv({ ADMIN_UI_ENABLED: 'true' }))).toThrow(/SLACK_CLIENT_ID/);
    const config = loadConfig(
      validEnv({
        ADMIN_UI_ENABLED: 'true',
        SLACK_CLIENT_ID: 'cid',
        SLACK_CLIENT_SECRET: 'csecret',
        ADMIN_SESSION_SECRET: 'session-secret',
      })
    );
    expect(config.adminUiEnabled).toBe(true);
    expect(config.slackClientId).toBe('cid');
  });
});

describe('LinkedIn API version', () => {
  test('defaults LINKEDIN_API_VERSION to a version inside LinkedIn\'s support window', () => {
    const config = loadConfig(validEnv());
    expect(config.linkedinVersion).toBe(DEFAULT_LINKEDIN_API_VERSION);
    expect(isLinkedinVersionStale(config.linkedinVersion, new Date('2026-10-19T00:00:00Z'))).toBe(false);
  });

  test('flags a version 11 or more months old (LinkedIn supports each for at least 12)', () => {
    const now = new Date('2026-10-19T00:00:00Z');
    expect(isLinkedinVersionStale('202506', now)).toBe(true);
    expect(isLinkedinVersionStale('202511', now)).toBe(true);
    expect(isLinkedinVersionStale('202512', now)).toBe(false);
    expect(isLinkedinVersionStale('202610', now)).toBe(false);
  });

  test('treats a missing or malformed version as stale', () => {
    expect(isLinkedinVersionStale(undefined)).toBe(true);
    expect(isLinkedinVersionStale('2026')).toBe(true);
    expect(isLinkedinVersionStale('202613')).toBe(true);
  });
});
