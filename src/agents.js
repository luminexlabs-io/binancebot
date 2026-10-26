const { log, warn } = require('./logger');
const { runProviderChain, parseJsonLoose, snapshotForPrompt, templateContent } = require('./content');
const { getSpotlightSnap } = require('./trends');

// Stages 2-4 of the pipeline: editor (pick this hour's play), writer (viral
// copy), critic (score + rewrite). Every agent runs through the same provider
// fallback chain; code-level validation happens after each call.

const TITLE_MAX = 70;
const CONTENT_MIN = 350;
const CONTENT_MAX = 800;

const FORMATS = ['market-recap', 'trend-spotlight', 'sentiment', 'education', 'question'];

const EDITOR_SYSTEM = `You are the strategy editor of an automated crypto account that posts on Binance Square every hour. Pick what THIS hour's post should be about to maximize engagement and trending potential.

Rules:
- Prefer trending coins that actually trade on Binance spot: the trending list marks each coin's "binancePair" (null = not listed). Majors (BTC, ETH, SOL, BNB, XRP) are always valid.
- If the chosen topic is a single coin, "symbol" must be its Binance pair (e.g. "SOLUSDT") or "NONE".
- NEVER pick a coin whose pair is in recentSymbolsToAvoid, and never a topic close to recentTopicsToAvoid - repetition kills engagement.
- Rotate formats: do NOT reuse mostRecentFormat unless the data strongly favors it. Vary the emotional register (hype, caution, curiosity, education).
- The hook must be specific and tied to a number or event actually present in the data.
- If Fear & Greed just crossed a zone (e.g. into Extreme Fear/Greed), a sentiment post is a strong pick.
- Reply ONLY with minified JSON:
{"topic": string, "symbol": string ("NONE" if the post is not about one coin), "angle": string, "format": one of "market-recap"|"trend-spotlight"|"sentiment"|"education"|"question", "hook": string, "hashtags": string[] (2-4 short tags like "BTC", "Altcoins")}`;

const WRITER_SYSTEM = `You write viral Binance Square posts for an automated crypto market account. Each post follows a per-format structure so consecutive posts never look alike.

Rules:
- Follow the FORMAT STRUCTURE block in the message exactly (opening move, middle, closing).
- First line hooks with a concrete number, contrast or event from the data. Never open with "The market is...".
- Mention the Fear & Greed Index ONLY in a "sentiment" post - never anywhere else.
- Every fact appears exactly once; never restate a number you already used.
- Confident but neutral tone, no financial advice, never promise profits, no hype scams.
- Use ONLY numbers and facts present in the provided data. Never invent on-chain stats, integrations, news or rankings.
- Plain text only (no markdown, no asterisks, no bullet symbols).
- Specific numbers from the data drive credibility.
- 2-4 hashtags in Binance Square format like #BTC# #ETH# on the last line.
- Reply ONLY with minified JSON: {"title": string, "content": string}. Title max ${TITLE_MAX} characters, content between ${CONTENT_MIN} and ${CONTENT_MAX} characters.`;

// One distinct skeleton per format - this is what stops every post from being
// "coin moved X%, volume Y, BTC at Z, F&G N, question".
const FORMAT_GUIDES = {
  'market-recap': `Open with the single most telling number across the majors. Middle: how the tracked majors split green vs red and which one is diverging from the pack. Closing: one sentence on what would change the picture in the next few hours (a statement, not a question).`,
  'trend-spotlight': `Open with what the coin did - its most unusual stat (move, volume spike or rank). Middle: 1-2 sentences of context on what the project is or why it is trending today, then the nearest support and resistance from the hourly candles. Closing: ask how traders are playing it.`,
  'sentiment': `Open with the Fear & Greed reading and whether it moved vs yesterday. Middle: where recent price action agrees or disagrees with that reading, plus one concrete level to watch. Closing: ask readers where the index goes next.`,
  'education': `Open by naming exactly ONE concept (e.g. what 24h quote volume really measures, why a trending rank says nothing about liquidity, what hourly wicks reveal). Middle: explain it in plain words using today's real numbers as the worked example. Closing: a one-line takeaway, then a light question.`,
  'question': `Open with a sharp, specific claim backed by one number (mildly contrarian is fine if defensible). Middle: 1-2 sentences of evidence from the data, including the strongest counter-argument. Closing: a direct either/or question to readers.`,
};

const CRITIC_SYSTEM = `You are a harsh social-media editor scoring Binance Square posts for viral potential (1-10). Criteria: hook strength (does the first line stop the scroll), specificity (real numbers), factual grounding (every number must be traceable to the data in the message - invented stats are an automatic fail), emotional pull, clarity, a closing that fits the intended format, hashtag quality, and distinctiveness - a post that reads like a rerun of the account's recent posts (listed in the message) must be heavily penalized. Deduct for vague claims, advice-y tone, repeated stats, walls of text, or weak endings.
Reply ONLY with minified JSON:
{"score": number (1-10), "issues": string (one short sentence, empty if score >= 8), "revised": {"title": string, "content": string} (only if score < 7; rewrite the post fixing the issues, same rules: hook first line, real numbers, plain text, format-fitting closing, 2-4 hashtags like #BTC# on the last line)}`;

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
    hourlyCandles: spotlightSnap.klines.slice(-12).map((k) => ({ o: k.open, h: k.high, l: k.low, c: k.close })),
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
  const user =
    `Score this draft. Intended format: ${strategy.format}. Topic: ${strategy.topic}.\n` +
    `Ground every number against this data (invented stats = score 1-2):\n` +
    `Live market data: ${snapshotForPrompt(snap)}\n` +
    (spotlightData ? `Spotlight coin data: ${spotlightData}\n` : '') +
    `Trend context: ${trendsForPrompt(trends, {})}\n` +
    `The account's recent posts (penalize anything that reads like a rerun of these):\n` +
    `${recent.titles?.slice(-5).map((t) => `- ${t}`).join('\n') || '(history unavailable)'}\n\n` +
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
  // Writers often drop Square's trailing hashtag hash ("#QNT" instead of
  // "#QNT#"), which breaks tagging on Square - normalize, but never at the
  // cost of exceeding the length limit.
  const normalized = finalPost.content.replace(
    // A hashtag needs at least one letter - "#38" (a rank) is not one.
    /#(?=[A-Za-z0-9]*[A-Za-z])([A-Za-z0-9]{2,20})(?=[\s]|$)/g,
    '#$1#'
  );
  return {
    title: finalPost.title,
    content: normalized.length <= CONTENT_MAX ? normalized : finalPost.content,
    meta,
    spotlightSnap,
  };
}

module.exports = { generateViralPost };
