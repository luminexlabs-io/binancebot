const { log, warn } = require('./logger');
const { runProviderChain, parseJsonLoose, snapshotForPrompt, templateContent } = require('./content');
const { getSpotlightSnap } = require('./trends');

// Stages 2-4 of the pipeline: editor (pick this hour's play), writer (viral
// copy), critic (score + rewrite). Every agent runs through the same provider
// fallback chain; code-level validation happens after each call.

const TITLE_MAX = 80;
const CONTENT_MIN = 300;
const CONTENT_MAX = 950;

const FORMATS = ['market-recap', 'trend-spotlight', 'sentiment', 'education', 'question', 'breaking-news', 'meme-debate'];

const EDITOR_SYSTEM = `You are the viral strategy editor of a crypto creator account on Binance Square. Pick what THIS post should be about to maximize engagement, discussions, and reach.

Rules:
- Focus on momentum & breaking stories: prefer coins with big 24h price moves, heavy volume spikes, trending signals, or major breaking headlines from newsHeadlines (regulations, macro, hacks, listings).
- Tracked majors ($BTC, $ETH, $SOL, $BNB, $XRP) are always strong candidates.
- If breaking news is significant, choose format "breaking-news" and feature the event!
- If market is sideways, a "meme-debate" or "sentiment" post drives massive engagement and comments.
- If the chosen topic is a single coin, "symbol" must be its Binance pair (e.g. "SOLUSDT") or "NONE".
- NEVER pick a coin whose pair is in recentSymbolsToAvoid, and never a topic close to recentTopicsToAvoid. Freshness and variety drive algorithmic push.
- Rotate formats: do NOT reuse mostRecentFormat unless market volatility strongly favors it.
- Craft a hook that creates curiosity, debate, or urgency tied to actual live numbers.
- Reply ONLY with minified JSON:
{"topic": string, "symbol": string ("NONE" if the post is not about one coin), "angle": string, "format": one of "market-recap"|"trend-spotlight"|"sentiment"|"education"|"question"|"breaking-news"|"meme-debate", "hook": string, "hashtags": string[] (2-4 tags like "Crypto", "Altcoins", "Trading")}`;

const WRITER_SYSTEM = `You are a top-tier crypto content creator and strategist writing viral posts for Binance Square.
Your goal is maximum engagement: scroll-stopping hooks, mobile readability, and debates that drive comments and shares.

Formatting & Structure Rules:
1. HEADLINE HOOK (First line):
   - Start with an attention-grabbing visual emoji (🚨, 🔥, 📊, ⚡) and a bold question or hook featuring the coin cashtag (e.g. "🚨 $LSK surges +24% — Breakout or Bull Trap?").
   - Follow immediately with a blank line (\n\n).

2. MOBILE-FIRST READABILITY:
   - NEVER output a solid wall of text. Break into short 1-2 sentence paragraphs separated by blank lines (\n\n).
   - Use clean bullet points (• ) for key levels (Support, Resistance, High/Low, or Volume stats).
   - Use tasteful emoji markers (e.g. 📊, 🎯, 💡, ⚠️, 👇) to guide the reader.

3. CASHTAGS ARE MANDATORY ($SYMBOL):
   - Every coin ticker mentioned MUST be prefixed with "$" (e.g. $BTC, $ETH, $SOL, $LSK). Never write bare tickers like "BTC" or "LSK".
   - Cashtags link directly to Binance trading pairs and index the post in that coin's community feed.

4. INSIGHT OVER STALE STATS:
   - Don't just list raw decimal numbers; give traders actionable context (momentum, risk/reward, support defense).
   - Confident, objective tone. No financial advice, no guaranteed profit claims.

5. ENGAGING CALL TO ACTION (CTA):
   - Conclude with a sharp, specific either/or question or debate prompt that forces readers to reply in comments (comments boost algorithmic reach by 10x).

6. BOTTOM TAG LINE:
   - Put coin cashtags first, followed by 2-3 clean hashtags (e.g. "$LSK $BTC #Crypto #Altcoins #Binance").
   - NEVER use trailing hashes like "#BTC#".

Reply ONLY with minified JSON: {"title": string, "content": string}. Title max ${TITLE_MAX} characters, content between ${CONTENT_MIN} and ${CONTENT_MAX} characters.`;

// One distinct skeleton per format - designed for visual hierarchy and mobile scanning.
const FORMAT_GUIDES = {
  'market-recap': `
- Opener: Bold headline with emoji on the most telling divergence across majors today.
- Section 1 (Market Pulse): How the majors split (green vs red), using $BTC as the anchor.
- Section 2 (Key Data): Bullet points (• ) showing key movers, volumes, and divergence.
- Closing: One decisive level that could flip momentum, then an engaging debate question for readers.`,

  'trend-spotlight': `
- Opener: Hook headline focusing on the spotlight coin's extreme move or volume spike.
- Section 1 (The Catalyst): 1-2 punchy sentences on what the project is and why momentum ignited today.
- Section 2 (Key Levels): Bullet points (• ) for Resistance, Support, and 24h High.
- Closing: Ask traders whether they are taking profits or riding to the next resistance.`,

  'sentiment': `
- Opener: Headline contrasting the current Fear & Greed Index reading against price action.
- Section 1 (Sentiment Check): Is the market acting fearful or greedy compared to what prices show?
- Section 2 (The Setup): Bullet points (• ) on key levels that could flip sentiment or trigger liquidations.
- Closing: Ask readers where they expect the market to head next.`,

  'education': `
- Opener: A sharp insight exposing a common trader mistake (e.g. volume vs liquidity, fake breakouts).
- Section 1 (The Lesson): Explain the concept in plain English using today's live numbers as the example.
- Section 2 (Takeaways): Bullet points (• ) with 2 actionable rules.
- Closing: A light takeaway and a question asking how traders handle this setup.`,

  'question': `
- Opener: A bold, slightly contrarian thesis backed by live numbers.
- Section 1 (The Setup): 2 short paragraphs giving the bull case vs the bear counter-argument.
- Section 2 (The Levels): Bullet points (• ) comparing the upside target vs breakdown risk.
- Closing: A direct voting question (e.g. "Bullish or Bearish from here? Drop your vote below 👇").`,

  'breaking-news': `
- Opener: 🚨 BREAKING: Bold headline with emoji on a major headline from newsHeadlines.
- Section 1 (The Scoop): 1-2 punchy sentences summarizing what just happened and why it matters.
- Section 2 (Market & Token Impact): Bullet points (• ) on price reaction, affected tokens ($BTC, $ETH, etc.), and key levels.
- Closing: Debate question: "Bullish long-term or short-term noise? Share your thoughts below 👇".`,

  'meme-debate': `
- Opener: A witty, relatable crypto hook or dilemma (e.g. dip buyers vs profit takers, diamond hands, bear trap psychology).
- Section 1 (The Sentiment): 1-2 sentences capturing trader emotion or market hype vs reality.
- Section 2 (The Data Reality): Bullet points (• ) comparing actual numbers vs public sentiment.
- Closing: An entertaining either/or question that compels traders to drop their vote below 👇.`,
};

const CRITIC_SYSTEM = `You are a top social-media strategist scoring Binance Square posts for viral reach (1-10).
Criteria:
- Scroll-stopping hook: does the first line have an emoji and a compelling headline?
- Formatting & readability: clean blank lines (\n\n) between short paragraphs, bullet points (• ) for levels. Dense walls of text MUST be scored below 6.
- Cashtag compliance: coins must use $SYMBOL cashtags (e.g. $BTC, $SOL).
- Factual grounding: every number must trace to provided data (invented stats = score 1-2).
- Comment-driving CTA: does the closing question provoke replies?
- No spammy trailing hashtags (no "#BTC#", use standard "#Crypto").

Reply ONLY with minified JSON:
{"score": number (1-10), "issues": string (empty if score >= 8), "revised": {"title": string, "content": string} (only if score < 7; rewrite with hook, line breaks, emojis, bullet points, $cashtags, and viral CTA)}`;

function trendsForPrompt(trends, recent = {}) {
  // Annotate each trending coin with its Binance pair (or null) so the editor
  // can make an informed spotlight choice instead of guessing.
  const all = trends.movers?.all;
  const binancePair = (sym) => {
    const pair = `${String(sym).toUpperCase()}USDT`;
    return all?.some((m) => m.symbol === pair) ? pair : null;
  };
  return JSON.stringify({
    coingeckoTrending: (trends.trending || []).map((c) => ({ ...c, binancePair: binancePair(c.symbol) })),
    fearGreedIndex: trends.fearGreed,
    topGainers24h: trends.movers?.gain ?? [],
    topLosers24h: trends.movers?.lose ?? [],
    topVolume24h: trends.movers?.volume ?? [],
    newsHeadlines: trends.news,
    recentTopicsToAvoid: recent.topics || [],
    recentSymbolsToAvoid: recent.symbols || [],
    recentPostTitles: (recent.titles || []).slice(-5),
    mostRecentFormat: recent.lastFormat || null,
  });
}

function firstHashtags(v) {
  if (!Array.isArray(v)) return [];
  return v.map((t) => String(t).replace(/^#+|#+#$/g, '').trim()).filter(Boolean).slice(0, 4);
}

function limitsIssues(post) {
  const issues = [];
  if (!post?.title?.trim()) issues.push('missing title');
  else if (post.title.length > TITLE_MAX) issues.push(`title is ${post.title.length} chars, max ${TITLE_MAX}`);
  if (!post?.content?.trim()) issues.push('missing content');
  else if (post.content.length < CONTENT_MIN) issues.push(`content is ${post.content.length} chars, minimum ${CONTENT_MIN}`);
  else if (post.content.length > CONTENT_MAX) issues.push(`content is ${post.content.length} chars, max ${CONTENT_MAX}`);
  return issues;
}

// Deterministic strategy when the editor fails or keeps repeating: spotlight
// the strongest listed signal NOT in excludeSymbols, else a plain market recap.
function fallbackStrategy(snap, trends, excludeSymbols = []) {
  const fresh = (pair) => !excludeSymbols.includes(pair);
  const listed = trends.movers?.all;
  const hotTrending = (trends.trending || []).find((c) => {
    const pair = `${c.symbol.toUpperCase()}USDT`;
    return fresh(pair) && listed?.some((m) => m.symbol === pair);
  });
  if (hotTrending) {
    const pair = `${hotTrending.symbol.toUpperCase()}USDT`;
    const t = listed.find((m) => m.symbol === pair);
    return {
      topic: hotTrending.name,
      symbol: pair,
      angle: 'why this coin is trending right now',
      format: 'trend-spotlight',
      hook: `${hotTrending.symbol.toUpperCase()} just entered CoinGecko's top trending list${t ? ` and is ${t.priceChangePercent >= 0 ? '+' : ''}${t.priceChangePercent.toFixed(1)}% in 24h` : ''}`,
      hashtags: [hotTrending.symbol.toUpperCase(), 'Crypto'],
    };
  }
  const sorted = [...snap.tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
  const gainer =
    (trends.movers?.gain || []).find((g) => fresh(g.symbol)) ||
    sorted.find((t) => fresh(t.symbol)) ||
    sorted[0];
  return {
    topic: `${gainer.symbol} momentum`,
    symbol: gainer.symbol,
    angle: 'the strongest gainer of the last 24h',
    format: 'market-recap',
    hook: `${gainer.symbol} leads the market ${gainer.priceChangePercent >= 0 ? '+' : ''}${gainer.priceChangePercent.toFixed(1)}% in 24h`,
    hashtags: [gainer.symbol.replace('USDT', ''), 'Crypto'],
  };
}

function toStrategy(value) {
  return {
    topic: String(value.topic).trim(),
    symbol: String(value.symbol || 'NONE').trim().toUpperCase(),
    angle: String(value.angle || '').trim(),
    format: FORMATS.includes(value.format) ? value.format : 'market-recap',
    hook: String(value.hook || '').trim(),
    hashtags: firstHashtags(value.hashtags),
  };
}

async function runEditor(snap, trends, recent, config) {
  const baseUser =
    `Decide this hour's post. Live market data: ${snapshotForPrompt(snap)}\n` +
    `Trend intelligence: ${trendsForPrompt(trends, recent)}`;
  const ask = (extra) =>
    runProviderChain(config, {
      system: EDITOR_SYSTEM,
      user: extra ? `${baseUser}\n\nIMPORTANT: ${extra}` : baseUser,
      temperature: 0.7,
      retriesPerProvider: 0,
      validate: (raw) => {
        const obj = parseJsonLoose(raw);
        if (!obj.topic || !String(obj.topic).trim()) throw new Error('missing "topic"');
        return obj;
      },
    });

  let strategy;
  try {
    const { value, provider } = await ask();
    strategy = toStrategy(value);
    log(`agents: editor (${provider}) -> ${strategy.format} on ${strategy.symbol} "${strategy.topic}"`);
  } catch (err) {
    warn(`agents: editor failed (${err.message}) - using deterministic strategy`);
    strategy = fallbackStrategy(snap, trends, recent.symbols);
    log(`agents: fallback strategy -> ${strategy.format} on ${strategy.symbol}`);
    return strategy;
  }

  // The editor's "avoid repeats" rule is soft - enforce it in code. One retry
  // with an explicit correction, then a deterministic fresh pick.
  if (strategy.symbol && strategy.symbol !== 'NONE' && recent.symbols.includes(strategy.symbol)) {
    warn(`agents: editor repeated recent symbol ${strategy.symbol} - retrying for a different pick`);
    try {
      const { value } = await ask(
        `You picked ${strategy.symbol}, which was already posted in the last 12 hours. Pick a DIFFERENT coin and a different format this time.`
      );
      const retry = toStrategy(value);
      if (!retry.symbol || retry.symbol === 'NONE' || !recent.symbols.includes(retry.symbol)) {
        strategy = retry;
      } else {
        strategy = fallbackStrategy(snap, trends, recent.symbols);
      }
    } catch (err) {
      warn(`agents: editor retry failed (${err.message}) - using deterministic strategy`);
      strategy = fallbackStrategy(snap, trends, recent.symbols);
    }
    log(`agents: editor final -> ${strategy.format} on ${strategy.symbol} "${strategy.topic}"`);
  }
  return strategy;
}

// Compact data block for the spotlight coin (its own candles + ticker), so
// writer and critic quote ITS levels instead of inventing or borrowing BTC's.
function spotlightForPrompt(spotlightSnap) {
  if (!spotlightSnap) return null;
  return JSON.stringify({
    symbol: spotlightSnap.mainSymbol,
    ticker: spotlightSnap.tickers[0],
    hourlyCandles: spotlightSnap.klines.slice(-6).map((k) => ({ o: k.open, h: k.high, l: k.low, c: k.close })),
  });
}

async function runWriter(strategy, snap, trends, recent, spotlightData, config) {
  const user =
    `FORMAT STRUCTURE (${strategy.format}): ${FORMAT_GUIDES[strategy.format]}\n` +
    `Recent posts from this account - yours must differ clearly in topic, opener and structure:\n` +
    `${recent.titles?.slice(-5).map((t) => `- ${t}`).join('\n') || '(history unavailable - rely on the format structure for variety)'}\n\n` +
    `Write the post. Strategy JSON: ${JSON.stringify(strategy)}\n` +
    `Live market data: ${snapshotForPrompt(snap)}\n` +
    (spotlightData ? `Spotlight coin data (quote support/resistance from THESE candles): ${spotlightData}\n` : '') +
    `Trend context: ${trendsForPrompt(trends, {})}`;
  const { value, provider } = await runProviderChain(config, {
    system: WRITER_SYSTEM,
    user,
    temperature: 0.9,
    retriesPerProvider: 1,
    validate: (raw) => {
      const obj = parseJsonLoose(raw);
      const post = { title: String(obj.title || '').trim(), content: String(obj.content || '').trim() };
      const issues = limitsIssues(post);
      if (issues.length) throw new Error(issues.join('; '));
      return post;
    },
  });
  return { post: value, provider };
}

async function runCritic(post, strategy, snap, trends, recent, spotlightData, config) {
  if (!config.critic.enabled) return null;
  await new Promise((r) => setTimeout(r, 1500));
  const user =
    `Score this draft. Intended format: ${strategy.format}. Topic: ${strategy.topic}.\n` +
    `Ground every number against this data:\n` +
    `Symbol: ${strategy.symbol}\n` +
    (spotlightData ? `Spotlight data: ${spotlightData}\n` : '') +
    `Tickers: ${JSON.stringify(snap.tickers.map((t) => ({ s: t.symbol, p: t.lastPrice, c: t.priceChangePercent, v: Math.round(t.quoteVolume) })))}\n` +
    `Fear & Greed: ${JSON.stringify(trends.fearGreed)}\n\n` +
    `Title: "${post.title}"\nContent:\n${post.content}`;
  try {
    const { value, provider } = await runProviderChain(config, {
      system: CRITIC_SYSTEM,
      user,
      temperature: 0.3,
      retriesPerProvider: 0,
      validate: (raw) => {
        const obj = parseJsonLoose(raw);
        const score = Number(obj.score);
        if (!Number.isFinite(score) || score < 1 || score > 10) throw new Error('score must be 1-10');
        return obj;
      },
    });
    const revised = value.revised &&
      typeof value.revised === 'object' &&
      limitsIssues({ title: value.revised.title, content: value.revised.content }).length === 0
      ? { title: String(value.revised.title).trim(), content: String(value.revised.content).trim() }
      : null;
    log(`agents: critic (${provider}) scored ${value.score}/10${revised ? ' with a rewrite attached' : ''}`);
    return { score: value.score, issues: String(value.issues || ''), revised };
  } catch (err) {
    warn(`agents: critic failed (${err.message}) - accepting the draft`);
    return null;
  }
}

function formatContentViral(content, title, strategySymbol, mainSymbol) {
  let text = String(content || '').trim();

  // 1. Ensure title hook is at the top if not already present
  if (title && title.trim()) {
    const cleanTitle = title.trim();
    const firstLine = text.split('\n')[0].toLowerCase();
    const titleSnippet = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    if (!firstLine.replace(/[^a-z0-9]/g, '').includes(titleSnippet)) {
      text = `${cleanTitle}\n\n${text}`;
    }
  }

  // 2. Clean trailing-hash syntax: #BTC# -> #BTC
  text = text.replace(/#([A-Za-z0-9_]+)#/g, '#$1');

  // 3. Normalize any $SYMBOLUSDT to $SYMBOL (e.g. $STXUSDT -> $STX)
  text = text.replace(/\$([A-Za-z0-9]+)USDT\b/g, '$$$1');

  // 4. Identify coins that should have cashtags
  const coins = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
  if (strategySymbol && strategySymbol !== 'NONE') {
    coins.add(strategySymbol.replace(/USDT$/, ''));
  }
  if (mainSymbol) {
    coins.add(mainSymbol.replace(/USDT$/, ''));
  }

  // 5. Ensure coin ticker mentions are cashtagged with "$"
  for (const coin of coins) {
    if (!coin || coin.length < 2) continue;
    const reg = new RegExp(`(?<![\\$#A-Za-z0-9])\\b${coin}\\b`, 'g');
    text = text.replace(reg, `$$${coin}`);
  }

  // 6. Ensure the spotlight and main coin cashtags appear cleanly in the footer
  const spotlightCoin = strategySymbol && strategySymbol !== 'NONE' ? strategySymbol.replace(/USDT$/, '') : null;
  const mainCoin = mainSymbol ? mainSymbol.replace(/USDT$/, '') : 'BTC';
  const targetCashtags = [];
  if (spotlightCoin) targetCashtags.push(`$${spotlightCoin}`);
  if (mainCoin && mainCoin !== spotlightCoin) targetCashtags.push(`$${mainCoin}`);

  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1].trim();
  const missing = targetCashtags.filter((tag) => !lastLine.includes(tag));

  if (missing.length > 0) {
    if (lastLine.includes('#') || lastLine.includes('$')) {
      lines[lines.length - 1] = `${missing.join(' ')} ${lastLine}`.trim();
      text = lines.join('\n');
    } else {
      text = `${text}\n\n${missing.join(' ')} #Crypto #BinanceSquare`;
    }
  }

  return text;
}

// Returns { title, content, meta, spotlightSnap }.
// meta.score is null when the critic is disabled/failed (gate treats it as pass)
// or when the template fallback is used (keeps the bot posting when AI is down).
// meta.rewritten is set when the critic's rewrite was applied - the scheduler
// gate then lets the post through instead of skipping the hour.
async function generateViralPost(snap, trends, recent, config) {
  const strategy = await runEditor(snap, trends, recent, config);

  // Spotlight only makes sense for a coin that isn't already the main chart.
  const spotlightSnap =
    strategy.symbol !== 'NONE' && strategy.symbol !== snap.mainSymbol
      ? await getSpotlightSnap(strategy.symbol, trends)
      : null;
  if (strategy.symbol !== 'NONE' && strategy.symbol !== snap.mainSymbol && !spotlightSnap) {
    warn(`agents: spotlight symbol ${strategy.symbol} not on Binance spot - post continues without its chart`);
  }

  let post;
  let provider = null;
  const spotlightData = spotlightForPrompt(spotlightSnap);
  try {
    ({ post, provider } = await runWriter(strategy, snap, trends, recent, spotlightData, config));
  } catch (err) {
    warn(`agents: writer failed everywhere (${err.message}) - using template`);
    const tpl = templateContent(snap);
    return {
      title: tpl.title,
      content: tpl.content,
      meta: { strategy, score: null, provider: 'template', criticNote: 'writer unavailable' },
      spotlightSnap: null,
    };
  }

  const critic = await runCritic(post, strategy, snap, trends, recent, spotlightData, config);
  let finalPost = post;
  let score = critic ? critic.score : null;
  let criticNote = critic ? critic.issues : null;
  let rewritten = false;

  if (critic && score < config.critic.minScore && critic.revised) {
    log(`agents: score ${score} < ${config.critic.minScore} - using the critic's rewrite`);
    finalPost = critic.revised;
    rewritten = true;
  }

  const meta = { strategy, score, provider, criticNote, rewritten };
  const formatted = formatContentViral(finalPost.content, finalPost.title, strategy.symbol, snap.mainSymbol);
  const finalContent = formatted.length <= CONTENT_MAX ? formatted : formatted.slice(0, CONTENT_MAX);

  return {
    title: finalPost.title,
    content: finalContent,
    meta,
    spotlightSnap,
  };
}

module.exports = { generateViralPost, formatContentViral };
