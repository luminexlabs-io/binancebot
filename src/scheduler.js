const cron = require('node-cron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { log, error } = require('./logger');
const { getMarketSnapshot } = require('./market');
const { generatePost } = require('./content');
const { renderPostImages } = require('./image');
const square = require('./square');

// Survives service restarts within the same instance (Render /tmp); used by
// the min-gap guard so a wake-from-sleep can't double-post.
const GAP_FILE = path.join(os.tmpdir(), 'bsap-last-post.json');

function loadLastSuccessAt() {
  try {
    const iso = JSON.parse(fs.readFileSync(GAP_FILE, 'utf8')).lastSuccessAt;
    return iso ? Date.parse(iso) : null;
  } catch {
    return null;
  }
}

function saveLastSuccessAt(iso) {
  try {
    fs.writeFileSync(GAP_FILE, JSON.stringify({ lastSuccessAt: iso }));
  } catch {
    /* ephemeral disk - non-fatal */
  }
}

const state = {
  startedAt: Date.now(),
  totalPosts: 0,
  lastRun: null,
  lastSuccessAt: loadLastSuccessAt(),
};

async function runCycle(config) {
  const startedAt = new Date();
  log('=== posting cycle start ===');
  try {
    const snap = await getMarketSnapshot(config.symbols, config.mainSymbol);
    log(`market: got ${snap.klines.length} candles + ${snap.tickers.length} tickers`);

    const post = await generatePost(snap, config);
    const images = await renderPostImages(snap);
    log(`images: rendered ${images.length} image(s) [${images.map((i) => i.name).join(', ')}]`);

    if (config.dryRunMode === 'true') {
      log(`DRY RUN - would publish: "${post.title}"`);
      log(`DRY RUN - post body:\n${post.content}`);
      log(`DRY RUN - image file(s): ${images.map((i) => i.path).join(', ')}`);
      state.lastRun = { at: startedAt.toISOString(), status: 'dry-run', detail: 'generated locally, published nothing' };
      return { ok: true, dryRun: true };
    }

    if (!config.squareApiKey) {
      throw new Error('BINANCE_SQUARE_OPENAPI_KEY is not configured - cannot publish');
    }

    const imageUrls = [];
    for (const img of images) {
      const url = await square.uploadImage(config.squareApiKey, img.buffer, img.name);
      imageUrls.push(url);
      log(`square: image online -> ${url}`);
    }

    if (config.dryRunMode === 'upload') {
      log(`DRY RUN (upload) - images uploaded OK; publish skipped. Would post: "${post.title}"`);
      state.lastRun = { at: startedAt.toISOString(), status: 'dry-run-upload', detail: `${imageUrls.length} image(s) uploaded, publish skipped` };
      return { ok: true, dryRun: true };
    }

    const result = await square.publishPost(config.squareApiKey, {
      text: post.content,
      imageUrls,
    });
    state.totalPosts += 1;
    state.lastSuccessAt = Date.now();
    saveLastSuccessAt(new Date().toISOString());
    state.lastRun = {
      at: startedAt.toISOString(),
      status: 'success',
      postId: result.id,
      link: result.link,
      images: imageUrls.length,
    };
    log(`square: POSTED ${result.link || '(no link returned)'} with ${imageUrls.length} image(s)`);
    log('=== posting cycle success ===');
    return { ok: true, link: result.link };
  } catch (err) {
    error(`cycle failed: ${err.message}`);
    state.lastRun = { at: startedAt.toISOString(), status: 'failed', error: err.message };
    log('=== posting cycle failed ===');
    return { ok: false, error: err.message };
  }
}

// A failed cycle is retried a couple of times (market data hiccups, Binance
// rate limits, etc.) before waiting for the next scheduled hour.
async function runCycleWithRetries(config) {
  for (let attempt = 1; attempt <= config.retries.max + 1; attempt++) {
    const result = await runCycle(config);
    if (result.ok) return result;
    if (attempt <= config.retries.max) {
      log(`retry ${attempt}/${config.retries.max} in ${Math.round(config.retries.delayMs / 60000)} min`);
      await new Promise((r) => setTimeout(r, config.retries.delayMs));
    }
  }
  return { ok: false };
}

// Best-effort "next run" display for the status endpoint (hourly crons only).
function nextRunAt(config) {
  const m = config.scheduleCron.match(/^(\d{1,2}) \* \* \* \*$/);
  if (!m) return null;
  const next = new Date();
  next.setUTCMinutes(Number(m[1]), 0, 0);
  if (next <= new Date()) next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

// Trigger used by the hourly cron and the boot-time run: never posts sooner
// than minGapMinutes after the previous real post.
function scheduledRun(config) {
  if (state.lastSuccessAt) {
    const mins = Math.round((Date.now() - state.lastSuccessAt) / 60000);
    if (mins < config.minGapMinutes) {
      log(`scheduler: skipping cycle - last successful post was ${mins} min ago (< ${config.minGapMinutes} min gap)`);
      return Promise.resolve({ ok: true, skipped: true });
    }
  }
  return runCycleWithRetries(config);
}

function start(config) {
  cron.schedule(
    config.scheduleCron,
    () => scheduledRun(config),
    { timezone: config.scheduleTimezone }
  );
  log(`scheduler: posting every hour (${config.scheduleCron} ${config.scheduleTimezone})`);
  // First post ~15s after boot so a fresh deploy confirms itself in the logs.
  setTimeout(() => scheduledRun(config), 15000);
}

module.exports = { start, scheduledRun, runCycle, runCycleWithRetries, nextRunAt, state };
