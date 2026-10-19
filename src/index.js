require('dotenv').config();

const { loadConfig, isLinkedinVersionStale } = require('./config');
const { createDb } = require('./db/knex');
const { createServer } = require('./server');
const { startExpiryReminderJob } = require('./jobs/expiryReminder');
const { startPostExpiryJob } = require('./jobs/postExpiry');
const { loadOverrides, mergeEffectiveConfig } = require('./admin/overrides');

async function main() {
  // envConfig is the pristine, never-mutated snapshot of Railway's env vars.
  // config (passed to createServer, jobs, and every handler) is a live copy
  // the admin config UI's reload controller mutates in place for
  // hot-reloadable variables (plans/env-var-ui-feature-spec.md Phase 3) —
  // keeping them separate means resetting an override always compares
  // against the true env default, not whatever the live object currently
  // holds.
  const envConfig = loadConfig();
  const db = createDb(envConfig);
  // Persisted admin overrides must be applied before anything else reads
  // `config` — otherwise every override is silently discarded on the next
  // restart (a Railway redeploy, a crash, or the admin UI's own restart
  // button), even though the dashboard still shows it as active. This runs
  // unconditionally (not gated on ADMIN_UI_ENABLED): the table is empty if
  // the feature was never used, so the merge is a harmless no-op, and an
  // override made while the UI was enabled shouldn't evaporate just because
  // the UI got turned off afterward.
  const overrides = await loadOverrides(db, envConfig.tokenEncryptionKey);
  const config = mergeEffectiveConfig(envConfig, overrides);
  // Overrides merge in AFTER loadConfig's fail-fast validation ran (which
  // only saw the env's mock-mode flag), so re-check the one cross-field
  // invariant they can break. applyOverride rejects creating this state, but
  // a row written before that guard existed (or a hand-edited one) must not
  // boot the app into real mode with null credentials — and crashing here
  // would take down the admin UI that could fix it, so fall back loudly.
  if (
    !config.linkedinMockMode &&
    !(config.linkedinClientId && config.linkedinClientSecret && config.linkedinRedirectUri)
  ) {
    console.error(
      'Ignoring LINKEDIN_MOCK_MODE=false override: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET ' +
        'and LINKEDIN_REDIRECT_URI are not configured — staying in mock mode'
    );
    config.linkedinMockMode = true;
  }
  if (!config.linkedinMockMode && isLinkedinVersionStale(config.linkedinVersion)) {
    console.warn(
      `LINKEDIN_API_VERSION ${config.linkedinVersion} is near or past LinkedIn's sunset ` +
        '— shares fail with 426 once it is retired; set a current YYYYMM version'
    );
  }
  // Mutable holder so the reload controller's cron-job restop (stop the old
  // task, start a new one with the updated schedule) and this file's
  // shutdown hook always reference the current task, never one captured at
  // boot.
  const jobs = { reminderJob: null, postExpiryJob: null };
  const { app } = createServer(config, db, { envConfig, jobs });

  // Fail fast on a bad REMINDER_CRON/POST_EXPIRY_CRON before traffic is accepted.
  jobs.reminderJob = startExpiryReminderJob({ config, db });
  jobs.postExpiryJob = startPostExpiryJob({ config, db });

  await app.start(config.port);
  console.log(
    `⚡ LowEffortLinkedIn listening on :${config.port}` +
      ` (env: ${config.nodeEnv}, LinkedIn mock mode: ${config.linkedinMockMode},` +
      ` reminder cron: ${config.reminderCron}, post expiry: ${config.defaultPostExpiryHours}h` +
      ` default / ${config.postExpiryCron})`
  );

  // Railway sends SIGTERM on redeploys; drain in-flight requests and release
  // the pool instead of dropping them mid-handler.
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    // db.destroy() waits on pending pool acquires, which can stall for the
    // full acquire timeout when the database is unreachable — force-exit as a
    // backstop so the container never hangs past its host's grace period.
    setTimeout(() => {
      console.error('Graceful shutdown stalled, forcing exit');
      process.exit(1);
    }, 10000).unref();
    try {
      jobs.reminderJob.stop();
      jobs.postExpiryJob.stop();
      await app.stop();
      await db.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
