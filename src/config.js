require('dotenv').config();

function envBool(v, dflt) {
  const s = String(v ?? (dflt ? 'true' : 'false')).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

const config = {
  port: Number(process.env.PORT || 3000),
  scheduleCron: process.env.POST_SCHEDULE_CRON || '0 * * * *',
  scheduleTimezone: process.env.POST_TIMEZONE || 'UTC',
  symbols: (process.env.POST_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  mainSymbol: (process.env.MAIN_SYMBOL || 'BTCUSDT').toUpperCase(),
  squareApiKey: process.env.BINANCE_SQUARE_OPENAPI_KEY || process.env.BINANCE_API_KEY || '',
  cryptoPanicKey: process.env.CRYPTOPANIC_API_KEY || '',
  critic: {
    enabled: envBool(process.env.CRITIC_ENABLED, true),
    minScore: Number(process.env.CRITIC_MIN_SCORE || 7),
  },
  gateGraceHours: Number(process.env.GATE_GRACE_HOURS || 2),
  spotlightChart: envBool(process.env.SPOTLIGHT_CHART, true),
  groq: {
    key: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  openrouter: {
    key: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
  },
  gemini: {
    key: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash',
  },
  retries: {
    max: Number(process.env.POST_RETRIES || 2),
    delayMs: Number(process.env.POST_RETRY_DELAY_MS || 15 * 60 * 1000),
  },
  // Minimum minutes between real posts. Guards against double-posting when the
  // service restarts or is woken by a keep-alive ping shortly after posting.
  minGapMinutes: Number(process.env.POST_MIN_GAP_MINUTES || 55),
};

// false = post for real | "upload" = upload images but skip publish | true = generate only
config.dryRunMode = (() => {
  const v = String(process.env.DRY_RUN ?? 'false').trim().toLowerCase();
  if (v === 'upload') return 'upload';
  return ['1', 'true', 'yes', 'on'].includes(v) ? 'true' : 'false';
})();

module.exports = config;
