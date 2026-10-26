const express = require('express');
const config = require('./config');
const { log, warn, error } = require('./logger');
const scheduler = require('./scheduler');
const keepalive = require('./keepalive');

// Node 20 kills the process on an unhandled rejection - the "bot silently
// off" failure mode. Log and ride it out instead; Render restarts on crash.
process.on('unhandledRejection', (err) => {
  error(`unhandledRejection: ${err?.stack || err}`);
});
process.on('uncaughtException', (err) => {
  error(`uncaughtException: ${err?.stack || err}`);
  process.exit(1); // Render restarts; the boot cycle posts the catch-up
});

const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'binance-square-autoposter',
    dryRun: config.dryRunMode,
    schedule: { cron: config.scheduleCron, timezone: config.scheduleTimezone },
    nextRunAt: scheduler.nextRunAt(config),
    totalPosts: scheduler.state.totalPosts,
    lastRun: scheduler.state.lastRun,
    lastPost: scheduler.state.lastPostMeta,
    trendsAt: scheduler.state.trendsAt,
    uptimeSec: Math.round((Date.now() - scheduler.state.startedAt) / 1000),
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
  // Every keep-alive ping doubles as a posting check (min-gap guarded): if the
  // service slept through its cron slot, the first ping after waking posts.
  scheduler.healthTick(config);
});

async function main() {
  log(`binance-square-autoposter starting (dryRun=${config.dryRunMode}, cron="${config.scheduleCron}", symbols=${config.symbols.join(',')})`);
  if (!config.squareApiKey) {
    warn('BINANCE_SQUARE_OPENAPI_KEY is not set - publishing will fail until it is added');
  }

  if (process.env.RUN_ONCE === '1') {
    const result = await scheduler.runCycle(config);
    log(`RUN_ONCE finished: ${JSON.stringify(result)}`);
    process.exit(0);
  }

  app.listen(config.port, () => {
    log(`health server listening on port ${config.port}`);
    keepalive.startSelfPing();
  });
  scheduler.start(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
