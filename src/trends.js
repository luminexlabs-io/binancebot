const { warn } = require('./logger');
const { getJson, getKlines } = require('./market');

// Stage 1 of the pipeline: gather trend signals from free public sources.
// Every fetcher is optional-graceful - a failing source is logged and skipped,
// never blocks the posting cycle.

async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    warn(`trends: ${label} failed: ${err.message}`);
    return fallback;
  }
}

// https://api.coingecko.com/api/v3/search/trending - keyless, ~1 call/hour is
// far below the free rate limit.
async function getCoinGeckoTrending() {
  return safe('coingecko-trending', async () => {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending', {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.coins || []).slice(0, 5).map(({ item }) => ({
      name: item.name,
      symbol: item.symbol,
      rank: item.market_cap_rank || null,
      change24hPct: item.data?.price_change_percentage_24h?.usd ?? null,
    }));
  }, []);
}

// https://api.alternative.me/fng/ - keyless crypto Fear & Greed Index.
async function getFearGreed() {
  return safe('fear-greed', async () => {
    const res = await fetch('https://api.alternative.me/fng/?limit=2', {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const [today, yesterday] = json.data || [];
    if (!today) throw new Error('empty payload');
    return {
      value: +today.value,
      label: today.value_classification,
      previous: yesterday ? +yesterday.value : null,
    };
  }, null);
}

// Full 24h ticker across Binance spot. Filtered to liquid USDT pairs
// (excludes leveraged UP/DOWN/BULL/BEAR tokens), then trimmed to the
// interesting edges. Also keeps the whole list: the editor uses it to check
// that a trending coin is actually tradeable on Binance before spotlighting.
const MIN_QUOTE_VOLUME = 5e6;

async function getTopMovers() {
  return safe('top-movers', async () => {
    const raw = await getJson('/api/v3/ticker/24hr');
    const all = raw
      .filter((t) => /USDT$/.test(t.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
      .map((t) => ({
        symbol: t.symbol,
        lastPrice: +t.lastPrice,
        priceChangePercent: +t.priceChangePercent,
        highPrice: +t.highPrice,
        lowPrice: +t.lowPrice,
        quoteVolume: +t.quoteVolume,
      }))
      .filter((t) => t.quoteVolume > MIN_QUOTE_VOLUME);
    if (all.length === 0) throw new Error('no liquid pairs returned');
    const by = (key) => [...all].sort((a, b) => b[key] - a[key]);
    return {
      all,
      gain: by('priceChangePercent').slice(0, 3),
      lose: by('priceChangePercent').slice(-3).reverse(),
      volume: by('quoteVolume').slice(0, 3),
    };
  }, null);
}

// https://cryptopanic.com/api/free/v1/posts/ - needs a free API token; when
// absent the editor simply works without news context.
async function getCryptoPanicNews(apiKey) {
  if (!apiKey) return [];
  return safe('cryptopanic', async () => {
    const url =
      `https://cryptopanic.com/api/free/v1/posts/?auth_token=${encodeURIComponent(apiKey)}` +
      '&public=true&filter=hot';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.results || []).slice(0, 5).map((p) => p.title);
  }, []);
}

async function getTrends(config) {
  const [trending, fearGreed, movers, news] = await Promise.all([
    getCoinGeckoTrending(),
    getFearGreed(),
    getTopMovers(),
    getCryptoPanicNews(config.cryptoPanicKey),
  ]);
  const sources = [
    trending.length && 'coingecko',
    fearGreed && 'fear-greed',
    movers && 'binance-movers',
    news.length && 'cryptopanic',
  ].filter(Boolean);
  return { trending, fearGreed, movers, news, sources, fetchedAt: new Date().toISOString() };
}

// Spotlight snapshot for a picked symbol: klines + its 24h stats, shaped like
// a market snapshot so renderPriceChart can draw it unchanged. The symbol is
// only accepted if it exists in the fetched Binance ticker list (guards
// against the LLM inventing a symbol).
async function getSpotlightSnap(symbol, trends) {
  if (!symbol || symbol === 'NONE') return null;
  const ticker = trends.movers?.all?.find((t) => t.symbol === symbol);
  if (!ticker) return null;
  return safe(`spotlight-${symbol}`, async () => {
    const klines = await getKlines(symbol, '1h', 48);
    return { mainSymbol: symbol, interval: '1h', klines, tickers: [ticker], fetchedAt: new Date().toISOString() };
  }, null);
}

module.exports = { getTrends, getSpotlightSnap };
