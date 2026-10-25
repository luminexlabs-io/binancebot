const { warn } = require('./logger');

// Public market-data hosts, tried in order. data-api.binance.vision serves the
// same public endpoints and is not geo-blocked where api.binance.com is.
const HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

async function getJson(pathAndQuery) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + pathAndQuery, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      warn(`market: host ${host} failed: ${err.message}`);
    }
  }
  throw new Error(`all Binance market hosts failed: ${lastErr.message}`);
}

function parseKlines(raw) {
  return raw.map((k) => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

async function getKlines(symbol, interval = '1h', limit = 48) {
  const raw = await getJson(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return parseKlines(raw);
}

async function get24h(symbols) {
  const q = encodeURIComponent(JSON.stringify(symbols));
  const raw = await getJson(`/api/v3/ticker/24hr?symbols=${q}`);
  return raw.map((t) => ({
    symbol: t.symbol,
    lastPrice: +t.lastPrice,
    priceChangePercent: +t.priceChangePercent,
    highPrice: +t.highPrice,
    lowPrice: +t.lowPrice,
    quoteVolume: +t.quoteVolume,
  }));
}

async function getMarketSnapshot(symbols, mainSymbol) {
  const [klines, tickers] = await Promise.all([
    getKlines(mainSymbol, '1h', 48),
    get24h(symbols),
  ]);
  return { mainSymbol, interval: '1h', klines, tickers, fetchedAt: new Date().toISOString() };
}

module.exports = { getMarketSnapshot, getKlines, get24h, getJson };
