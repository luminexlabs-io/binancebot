const { log, warn } = require('./logger');

const ANGLES = [
  'a short-term technical outlook (support/resistance, momentum)',
  'what the 24h moves say about overall market sentiment',
  'key price levels traders should watch in the coming hours',
  'a balanced, risk-focused take on the current price action',
];

const SYSTEM = `You write engaging Binance Square posts for a crypto market account. Rules:
- Confident, objective tone; no financial advice; never promise profits.
- Start with a compelling headline hook with an emoji (e.g. 🚨, 📊, ⚡).
- Use blank lines (\n\n) between short paragraphs for mobile readability.
- Use bullet points (• ) for key price stats and support/resistance levels.
- Always use $SYMBOL cashtags for coins (e.g. $BTC, $ETH).
- End with a sharp question to encourage replies and discussion.
- Use clean tags on the last line (e.g. $BTC #Crypto #BinanceSquare). No trailing hashes like "#BTC#".
- Reply ONLY with minified JSON: {"title": string, "content": string}. Title max 80 characters, content 350-900 characters.`;

function fmtPrice(v) {
  if (v >= 1000) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toPrecision(4);
}

function snapshotForPrompt(snap) {
  return JSON.stringify({
    timeUtc: snap.fetchedAt,
    mainSymbol: snap.mainSymbol,
    hourlyCandles: snap.klines.slice(-6).map((k) => ({ o: k.open, h: k.high, l: k.low, c: k.close })),
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

// payload = { system, user, temperature }
async function callOpenAICompatible(url, headers, cfg, payload) {
  const json = await postJson(url, headers, {
    model: cfg.model,
    temperature: payload.temperature ?? 0.85,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: payload.system },
      { role: 'user', content: payload.user },
    ],
  });
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

async function generateWithGroq(payload, cfg) {
  return callOpenAICompatible(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${cfg.key}` },
    cfg,
    payload
  );
}

async function generateWithOpenRouter(payload, cfg) {
  return callOpenAICompatible(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      Authorization: `Bearer ${cfg.key}`,
      'HTTP-Referer': 'https://render.com',
      'X-Title': 'binance-square-autoposter',
    },
    cfg,
    payload
  );
}

async function generateWithGemini(payload, cfg) {
  // AIza... keys go in the query string; OAuth-style tokens (AQ....) as Bearer.
  const isApiKey = cfg.key.startsWith('AIza');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent` +
    (isApiKey ? `?key=${cfg.key}` : '');
  const headers = {};
  if (!isApiKey) headers.Authorization = `Bearer ${cfg.key}`;
  const json = await postJson(url, headers, {
    contents: [{ role: 'user', parts: [{ text: payload.system + '\n\n' + payload.user }] }],
    generationConfig: { temperature: payload.temperature ?? 0.85, responseMimeType: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
  if (!text) throw new Error('empty completion');
  return text;
}

function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON found in model output');
  return JSON.parse(m[0]);
}

// Runs one agent prompt across the provider fallback chain. `validate(rawText)`
// must return the parsed value or throw; a failed validation retries the same
// provider once with the error appended as a correction, then moves on.
async function runProviderChain(config, { system, user, temperature = 0.85, validate, retriesPerProvider = 1 }) {
  const providers = [
    ['groq', generateWithGroq, config.groq],
    ['openrouter', generateWithOpenRouter, config.openrouter],
    ['gemini', generateWithGemini, config.gemini],
  ];
  for (const [name, fn, cfg] of providers) {
    if (!cfg.key) continue;
    let userMsg = user;
    for (let attempt = 0; attempt <= retriesPerProvider; attempt++) {
      try {
        const value = validate
          ? validate(await fn({ system, user: userMsg, temperature }, cfg))
          : await fn({ system, user: userMsg, temperature }, cfg);
        log(`llm: ${name} accepted (attempt ${attempt + 1})`);
        return { value, provider: name };
      } catch (err) {
        warn(`llm: ${name} attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < retriesPerProvider) {
          userMsg = `${user}\n\nYour previous reply failed: ${err.message}. Reply again with corrected minified JSON only.`;
        }
      }
    }
  }
  throw new Error('all AI providers failed');
}

function templateContent(snap) {
  const rows = [...snap.tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
  const main = snap.tickers.find((t) => t.symbol === snap.mainSymbol) || rows[0];
  const sign = (v) => (v >= 0 ? '+' : '');
  const mainSym = snap.mainSymbol.replace(/USDT$/, '');
  const lines = [
    `📊 Market Check: $${mainSym} holding near ${fmtPrice(main.lastPrice)}`,
    '',
    `24h momentum update for $${mainSym} (${sign(main.priceChangePercent)}${main.priceChangePercent.toFixed(2)}%):`,
    '',
    'Performance across majors:',
    ...rows.map((t) => `• $${t.symbol.replace(/USDT$/, '')}: ${fmtPrice(t.lastPrice)} (${sign(t.priceChangePercent)}${t.priceChangePercent.toFixed(2)}%)`),
    '',
    '👇 How are you positioning for the next session? Bullish or cautious?',
    '',
    `$${mainSym} $BTC #Crypto #BinanceSquare #Trading`,
  ];
  return {
    title: `Market Check: $${mainSym} ${main.priceChangePercent >= 0 ? 'Up' : 'Down'} ${Math.abs(main.priceChangePercent).toFixed(1)}% in 24h`,
    content: lines.join('\n'),
  };
}

async function generatePost(snap, config) {
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const prompt =
    `Write a Binance Square post from this live Binance spot data. ` +
    `Angle for this hour: ${angle}. Data: ${snapshotForPrompt(snap)}`;

  try {
    const { value } = await runProviderChain(config, {
      system: SYSTEM,
      user: prompt,
      temperature: 0.85,
      validate: (raw) => {
        const obj = parseJsonLoose(raw);
        if (!obj.content) throw new Error('missing "content" field');
        return { title: String(obj.title || '').trim(), content: String(obj.content).trim() };
      },
    });
    return value;
  } catch (err) {
    warn(`content: ${err.message}, using built-in template`);
    return templateContent(snap);
  }
}

module.exports = { generatePost, templateContent, runProviderChain, parseJsonLoose, snapshotForPrompt };
