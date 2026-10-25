const express = require('express');
const config = require('./config');
const { log, warn } = require('./logger');
const scheduler = require('./scheduler');

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
  });
  scheduler.start(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
