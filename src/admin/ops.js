// Health check + restart — plans/env-var-ui-feature-spec.md Phase 3.
//
// Restart note (spec Finding F3, downgraded to "document, don't build"): a
// single Railway service instance has no zero-downtime restart story. This
// endpoint discloses that in its own response rather than pretending
// otherwise — it is not graceful in the sense of avoiding an outage window,
// only in the sense of returning a response before exiting.
//
// Environment name (Finding F4): the roadmap's original Phase 4.1 asked for
// live switching between Railway environments from one running instance.
// That needs the OTHER environment's DATABASE_URL (and likely its
// TOKEN_ENCRYPTION_KEY) available somewhere — the exact bootstrap-secret
// problem the allow-list exists to avoid. Descoped to a read-only label
// naming which environment THIS instance is running as, sourced from
// Railway's own injected variable.

const { requireAdminSession } = require('./auth');
const { isLinkedinVersionStale } = require('../config');

async function probeDb(db) {
  try {
    await db.raw('select 1').timeout(2000, { cancel: true });
    return 'up';
  } catch {
    return 'down';
  }
}

async function probeSlack(slackClient) {
  try {
    const result = await slackClient.auth.test();
    return result.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

// LinkedIn has no lightweight unauthenticated ping endpoint — this reports
// configuration state, not live connectivity, which is enough to catch the
// "forgot to set the client secret after flipping mock mode off" class of
// mistake this UI exists to prevent.
// A stale LINKEDIN_API_VERSION reads as not-ok too: every real share would
// fail with 426 once LinkedIn sunsets it.
function probeLinkedin(config, now = new Date()) {
  if (config.linkedinMockMode) return 'mock';
  if (!(config.linkedinClientId && config.linkedinClientSecret)) return 'not configured';
  if (isLinkedinVersionStale(config.linkedinVersion, now)) {
    return `configured (API version ${config.linkedinVersion} is near or past sunset)`;
  }
  return 'configured';
}

// Railway injects RAILWAY_ENVIRONMENT_NAME; config.nodeEnv is the fallback
// for non-Railway (e.g. local dev) deployments.
function currentEnvironmentName(config) {
  return process.env.RAILWAY_ENVIRONMENT_NAME || config.nodeEnv;
}

function registerAdminOps(router, { config, db, slackClient, logger = console }) {
  const auth = requireAdminSession(config);

  router.get('/admin/api/health', auth, async (_req, res) => {
    const [dbStatus, slackStatus] = await Promise.all([probeDb(db), probeSlack(slackClient)]);
    res.json({
      db: dbStatus,
      slack: slackStatus,
      linkedin: probeLinkedin(config),
      environment: currentEnvironmentName(config),
    });
  });

  router.post('/admin/api/restart', auth, (req, res) => {
    logger.info(`Admin restart requested by ${req.adminSlackUserId}`);
    // Hand off to index.js's SIGTERM handler rather than exiting cold: a bare
    // process.exit() here would drop in-flight handlers (a share pipeline
    // killed between the LinkedIn post and its shares insert forgets the
    // share — the idempotency guard then lets the user post it twice) and
    // could cut the connection before this response reaches the browser.
    // Signalled on 'finish' so the response has flushed first, with a timed
    // backstop in case 'finish' never fires; Railway's restart policy brings
    // the container back up with the now-persisted config. That relaunch
    // depends on railway.json's restartPolicyType being ALWAYS: the graceful
    // path exits 0, and under ON_FAILURE a zero-exit container is left
    // stopped — this button would take the service down until someone
    // manually redeploys.
    let signalled = false;
    const requestShutdown = () => {
      if (signalled) return;
      signalled = true;
      process.kill(process.pid, 'SIGTERM');
    };
    res.on('finish', requestShutdown);
    setTimeout(requestShutdown, 3000).unref();
    res.json({
      ok: true,
      message: 'Restarting now — the app will be briefly unavailable while the platform relaunches it.',
    });
  });
}

module.exports = { registerAdminOps, probeDb, probeSlack, probeLinkedin, currentEnvironmentName };
