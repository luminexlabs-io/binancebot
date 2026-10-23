const { log, warn } = require('./logger');

const ANGLES = [
  'a short-term technical outlook (support/resistance, momentum)',
  'what the 24h moves say about overall market sentiment',
  'key price levels traders should watch in the coming hours',
  'a balanced, risk-focused take on the current price action',
];

const SYSTEM = `You write Binance Square posts for an automated crypto market account. Rules:
- Confident but neutral tone, no financial advice, never promise profits.
- Hook the reader in the first sentence and reference the actual numbers provided.
- Plain text only (no markdown, no asterisks). Use 2-4 hashtags in Binance Square format like #BTC# #ETH# on the last line.
- Reply ONLY with minified JSON: {"title": string, "content": string}. Title max 70 characters, content 350-800 characters.`;

function fmtPrice(v) {
  if (v >= 1000) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toPrecision(4);
}

function snapshotForPrompt(snap) {
  return JSON.stringify({
    timeUtc: snap.fetchedAt,
    mainSymbol: snap.mainSymbol,
    hourlyCandles: snap.klines.slice(-12).map((k) => ({ o: k.open, h: k.high, l: k.low, c: k.close })),
    tickers: snap.tickers.map((t) => ({
      symbol: t.symbol,
      price: t.lastPrice,
      change24hPct: t.priceChangePercent,
      volume24hUsd: Math.round(t.quoteVolume),
    })),
  });
}

async function postJson(url, headers, body, timeoutMs = 45000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function callOpenAICompatible(url, headers, cfg, prompt) {
  const json = await postJson(url, headers, {
    model: cfg.model,
    temperature: 0.85,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
  });
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

async function generateWithGroq(prompt, cfg) {
  return callOpenAICompatible(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${cfg.key}` },
    cfg,
    prompt
  );
}

async function generateWithOpenRouter(prompt, cfg) {
  return callOpenAICompatible(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      Authorization: `Bearer ${cfg.key}`,
      'HTTP-Referer': 'https://render.com',
      'X-Title': 'binance-square-autoposter',
    },
    cfg,
    prompt
  );
}

async function generateWithGemini(prompt, cfg) {
  // AIza... keys go in the query string; OAuth-style tokens (AQ....) as Bearer.
  const isApiKey = cfg.key.startsWith('AIza');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent` +
    (isApiKey ? `?key=${cfg.key}` : '');
  const headers = {};
  if (!isApiKey) headers.Authorization = `Bearer ${cfg.key}`;
  const json = await postJson(url, headers, {
    contents: [{ role: 'user', parts: [{ text: SYSTEM + '\n\n' + prompt }] }],
    generationConfig: { temperature: 0.85, responseMimeType: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
  if (!text) throw new Error('empty completion');
  return text;
}

function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON found in model output');
  const obj = JSON.parse(m[0]);
  if (!obj.content) throw new Error('missing "content" field');
  return { title: String(obj.title || '').trim(), content: String(obj.content).trim() };
}

function templateContent(snap) {
  const rows = [...snap.tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
  const main = snap.tickers.find((t) => t.symbol === snap.mainSymbol) || rows[0];
  const sign = (v) => (v >= 0 ? '+' : '');
  const lines = [
    `Hourly market update (${snap.fetchedAt.slice(0, 16)} UTC)`,
    '',
    `${snap.mainSymbol} is trading around ${fmtPrice(main.lastPrice)} (${sign(main.priceChangePercent)}${main.priceChangePercent.toFixed(2)}% in 24h).`,
    '',
    '24h performance across majors:',
    ...rows.map((t) => `- ${t.symbol}: ${fmtPrice(t.lastPrice)} (${sign(t.priceChangePercent)}${t.priceChangePercent.toFixed(2)}%)`),
    '',
    'Not financial advice. Data: Binance spot.',
    '#BTC# #Crypto# #BinanceSquare#',
  ];
  return {
    title: `Market Check: ${snap.mainSymbol} ${main.priceChangePercent >= 0 ? 'Up' : 'Down'} ${Math.abs(main.priceChangePercent).toFixed(1)}% in 24h`,
    content: lines.join('\n'),
  };
}

async function generatePost(snap, config) {
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const prompt =
    `Write a Binance Square post from this live Binance spot data. ` +
    `Angle for this hour: ${angle}. Data: ${snapshotForPrompt(snap)}`;

  const providers = [
    ['groq', generateWithGroq, config.groq],
    ['openrouter', generateWithOpenRouter, config.openrouter],
    ['gemini', generateWithGemini, config.gemini],
  ];
  for (const [name, fn, cfg] of providers) {
    if (!cfg.key) continue;
    try {
      const parsed = parseJsonLoose(await fn(prompt, cfg));
      log(`content: generated via ${name} (title ${parsed.title.length} chars, body ${parsed.content.length} chars)`);
      return parsed;
    } catch (err) {
      warn(`content: provider ${name} failed: ${err.message}`);
    }
  }
  warn('content: all AI providers failed, using built-in template');
  return templateContent(snap);
}

module.exports = { generatePost, templateContent };
