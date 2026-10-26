const cron = require('node-cron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { log, warn, error } = require('./logger');
const { getMarketSnapshot, getKlines } = require('./market');
const { getTrends } = require('./trends');
const { generateViralPost } = require('./agents');
const { renderPostImages } = require('./image');
const square = require('./square');

// Survives service restarts within the same instance (Render /tmp); used by
// the min-gap guard so a wake-from-sleep can't double-post.
const GAP_FILE = path.join(os.tmpdir(), 'bsap-last-post.json');
// Post history for topic rotation + the status page. Same ephemeral disk, so
// on a fresh instance it starts empty (the bot then simply has no recent
// topics to avoid - acceptable degradation).
const HISTORY_FILE = path.join(os.tmpdir(), 'bsap-history.json');
const HISTORY_MAX = 50;
const REPEAT_BLOCK_HOURS = 12;

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

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).posts;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function savePostHistory(entry) {
  try {
    const posts = [...loadHistory(), entry].slice(-HISTORY_MAX);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ posts }));
  } catch {
    /* ephemeral disk - non-fatal */
  }
}

// What was posted in the last REPEAT_BLOCK_HOURS, so the agents rotate
// instead of repeating. Symbols/titles are exact strings from history, which
// makes dedupe enforceable in code (topics alone are free-text).
function recentContext() {
  const cutoff = Date.now() - REPEAT_BLOCK_HOURS * 3600 * 1000;
  const posts = loadHistory().filter((p) => Date.parse(p.at) > cutoff);
  return {
    topics: posts.map((p) => p.topic).filter(Boolean),
    symbols: [...new Set(posts.map((p) => p.symbol).filter(Boolean))],
    titles: posts.map((p) => p.title).filter(Boolean),
    lastFormat: posts.length ? posts[posts.length - 1].format : null,
  };
}

const state = {
  startedAt: Date.now(),
  totalPosts: 0,
  lastRun: null,
  lastSuccessAt: loadLastSuccessAt(),
  lastPostMeta: null,
  trendsAt: null,
  running: false,
};

// The lead chart must not be BTC every hour. When the editor picked no coin
// (or picked the main one), rotate the lead among the tracked majors by hour
// so the images keep changing even in quiet markets.
async function rotateLeadSnap(snap, config) {
  const seed = Math.floor(Date.now() / 3600000);
  const symbol = config.symbols[seed % config.symbols.length];
  if (symbol === snap.mainSymbol) return snap;
  const ticker = snap.tickers.find((t) => t.symbol === symbol);
  if (!ticker) return snap;
  try {
    const klines = await getKlines(symbol, '1h', 48);
    return { ...snap, mainSymbol: symbol, klines };
  } catch (err) {
    warn(`scheduler: lead rotation to ${symbol} failed (${err.message}) - staying on ${snap.mainSymbol}`);
    return snap;
  }
}

async function runCycle(config) {
  const startedAt = new Date();
  log('=== posting cycle start ===');
  try {
    const [snap, trends] = await Promise.all([
      getMarketSnapshot(config.symbols, config.mainSymbol),
      getTrends(config),
    ]);
    state.trendsAt = trends.fetchedAt;
    log(
      `trends: sources [${trends.sources.join(', ') || 'none'}] - ` +
        `${trends.trending.length} trending, F&G ${trends.fearGreed ? trends.fearGreed.value : 'n/a'}, ` +
        `${trends.news.length} headlines`
    );
    log(`market: got ${snap.klines.length} candles + ${snap.tickers.length} tickers`);

    const recent = recentContext();
    const viral = await generateViralPost(snap, trends, recent, config);
    log(`agents: draft ready (score ${viral.meta.score ?? 'n/a'}, via ${viral.meta.provider})`);

    const leadSnap = viral.spotlightSnap || (await rotateLeadSnap(snap, config));
    const images = await renderPostImages({
      leadSnap,
      majorsSnap: snap,
      fearGreed: trends.fearGreed,
      hourSeed: Math.floor(Date.now() / 3600000),
    });
    log(`images: rendered ${images.length} image(s) [${images.map((i) => i.name).join(', ')}]`);

    if (config.dryRunMode === 'true') {
      log(`DRY RUN - would publish: "${viral.title}"`);
      log(`DRY RUN - post body:\n${viral.content}`);
      log(`DRY RUN - image file(s): ${images.map((i) => i.path).join(', ')}`);
      state.lastRun = { at: startedAt.toISOString(), status: 'dry-run', detail: 'generated locally, published nothing' };
      return { ok: true, dryRun: true };
    }

    if (!config.squareApiKey) {
      throw new Error('BINANCE_SQUARE_OPENAPI_KEY is not configured - cannot publish');
    }

    // Quality gate: below-threshold drafts are skipped while the account has
    // posted recently - UNLESS the critic already rewrote them (meta.rewritten),
    // which counts as fixed. After gateGraceHours of silence, post the best
    // available draft anyway - an idle account is worse than an imperfect one.
    if (
      config.dryRunMode === 'false' &&
      !viral.meta.rewritten &&
      viral.meta.score !== null &&
      viral.meta.score < config.critic.minScore
    ) {
      const hoursSince = state.lastSuccessAt ? (Date.now() - state.lastSuccessAt) / 3600000 : Infinity;
      if (hoursSince < config.gateGraceHours) {
        log(`scheduler: quality gate - score ${viral.meta.score} < ${config.critic.minScore}, last post ${hoursSince.toFixed(1)}h ago; skipping this hour`);
        state.lastRun = {
          at: startedAt.toISOString(),
          status: 'quality-skip',
          score: viral.meta.score,
          topic: viral.meta.strategy.topic,
        };
        return { ok: true, skipped: 'quality' };
      }
      log(`scheduler: score ${viral.meta.score} below threshold but account silent ${hoursSince.toFixed(1)}h - posting best draft`);
    }

    const imageUrls = [];
    for (const img of images) {
      const url = await square.uploadImage(config.squareApiKey, img.buffer, img.name);
      imageUrls.push(url);
      log(`square: image online -> ${url}`);
    }

    if (config.dryRunMode === 'upload') {
      log(`DRY RUN (upload) - images uploaded OK; publish skipped. Would post: "${viral.title}"`);
      state.lastRun = { at: startedAt.toISOString(), status: 'dry-run-upload', detail: `${imageUrls.length} image(s) uploaded, publish skipped` };
      return { ok: true, dryRun: true };
    }

    const result = await square.publishPost(config.squareApiKey, {
      text: viral.content,
      imageUrls,
    });
    state.totalPosts += 1;
    state.lastSuccessAt = Date.now();
    saveLastSuccessAt(new Date().toISOString());
    state.lastPostMeta = {
      topic: viral.meta.strategy.topic,
      symbol: viral.meta.strategy.symbol,
      format: viral.meta.strategy.format,
      score: viral.meta.score,
      provider: viral.meta.provider,
      postId: result.id,
      at: new Date().toISOString(),
    };
    savePostHistory({ ...state.lastPostMeta, title: viral.title });
    state.lastRun = {
      at: startedAt.toISOString(),
      status: 'success',
      postId: result.id,
      link: result.link,
      images: imageUrls.length,
      topic: viral.meta.strategy.topic,
      score: viral.meta.score,
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

// Trigger used by the hourly cron, boot, and health-tick pings: one cycle at a
// time, and never sooner than minGapMinutes after the previous real post.
// The health-tick is what makes the bot survive Render free-tier sleeps: the
// first ping after a wake-up posts (catching up the missed cron slot), so
// posting no longer depends on the process being awake at exactly :00.
async function scheduledRun(config) {
  if (state.running) {
    log('scheduler: cycle already in progress - skipping this trigger');
    return { ok: true, skipped: true };
  }
  state.running = true;
  try {
    if (state.lastSuccessAt) {
      const mins = Math.round((Date.now() - state.lastSuccessAt) / 60000);
      if (mins < config.minGapMinutes) {
        log(`scheduler: skipping cycle - last successful post was ${mins} min ago (< ${config.minGapMinutes} min gap)`);
        return { ok: true, skipped: true };
      }
    }
    return await runCycleWithRetries(config);
  } finally {
    state.running = false;
  }
}

// Fire-and-forget tick for the /healthz endpoint (keep-alive pings).
function healthTick(config) {
  scheduledRun(config).catch((err) => error(`scheduler: healthTick failed: ${err.message}`));
}

function start(config) {
  cron.schedule(
    config.scheduleCron,
    // .catch keeps an unexpected rejection from becoming an unhandled
    // rejection (which would kill the process on Node 20).
    () => scheduledRun(config).catch((err) => error(`scheduler: cron run crashed: ${err?.stack || err}`)),
    { timezone: config.scheduleTimezone }
  );
  log(`scheduler: posting every hour (${config.scheduleCron} ${config.scheduleTimezone})`);
  // First post ~15s after boot so a fresh deploy confirms itself in the logs.
  setTimeout(
    () => scheduledRun(config).catch((err) => error(`scheduler: boot run crashed: ${err?.stack || err}`)),
    15000
  );
}

module.exports = { start, scheduledRun, healthTick, runCycle, runCycleWithRetries, nextRunAt, state };
