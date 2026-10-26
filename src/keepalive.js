const { log, warn } = require('./logger');

// Render's free plan sleeps a web service after ~15 minutes without INBOUND
// traffic, which kills the in-process hourly cron. Once the process is awake,
// a request to its own public URL counts as inbound traffic and resets that
// idle timer - so a single wake-up (deploy, external pinger, any visit) is
// enough and the service keeps itself awake around the clock from then on.
// A sleeping process cannot run this code, so an external pinger stays useful
// as the wake-up source of last resort (see README "Keeping Render awake").
// Render provides RENDER_EXTERNAL_URL automatically; SELF_URL overrides it.
function startSelfPing() {
  const base = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    log('keepalive: no RENDER_EXTERNAL_URL/SELF_URL - self-ping disabled (local dev)');
    return null;
  }
  const everyMin = Math.max(5, Number(process.env.SELF_PING_MINUTES || 10));
  let failures = 0;
  const timer = setInterval(() => {
    fetch(`${base}/healthz`, { signal: AbortSignal.timeout(20000) })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (failures > 0) log(`keepalive: self-ping recovered after ${failures} failure(s)`);
        failures = 0;
      })
      .catch((err) => {
        failures += 1;
        warn(`keepalive: self-ping #${failures} failed: ${err.message}`);
      });
  }, everyMin * 60 * 1000);
  timer.unref?.();
  log(`keepalive: self-ping ${base}/healthz every ${everyMin} min (resets Render's idle timer)`);
  return timer;
}

module.exports = { startSelfPing };
