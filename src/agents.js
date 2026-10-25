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
- NEVER pick a topic listed in recentTopicsToAvoid - repetition kills engagement.
- Rotate across formats; vary the emotional register (hype, caution, curiosity, education).
- The hook must be specific and tied to a number or event actually present in the data.
- If Fear & Greed just crossed a zone (e.g. into Extreme Fear/Greed), a sentiment post is a strong pick.
- Reply ONLY with minified JSON:
{"topic": string, "symbol": string ("NONE" if the post is not about one coin), "angle": string, "format": one of "market-recap"|"trend-spotlight"|"sentiment"|"education"|"question", "hook": string, "hashtags": string[] (2-4 short tags like "BTC", "Altcoins")}`;

const WRITER_SYSTEM = `You write viral Binance Square posts for an automated crypto market account. Rules:
- First line is the hook: a concrete number, contrast or event from the data. No generic openers like "The market is...".
- Confident but neutral tone, no financial advice, never promise profits, no hype scams.
- Plain text only (no markdown, no asterisks, no bullet symbols).
- Use specific numbers from the data (prices, %, volumes) - specificity drives credibility.
- End with a short question that invites replies (questions boost ranking).
- 2-4 hashtags in Binance Square format like #BTC# #ETH# on the last line.
- Reply ONLY with minified JSON: {"title": string, "content": string}. Title max ${TITLE_MAX} characters, content between ${CONTENT_MIN} and ${CONTENT_MAX} characters.`;

const CRITIC_SYSTEM = `You are a harsh social-media editor scoring Binance Square posts for viral potential (1-10). Criteria: hook strength (does the first line stop the scroll), specificity (real numbers), emotional pull, clarity, a closing question, hashtag quality, and fit to the intended format. Deduct for vague claims, advice-y tone, walls of text, or weak endings.
Reply ONLY with minified JSON:
{"score": number (1-10), "issues": string (one short sentence, empty if score >= 8), "revised": {"title": string, "content": string} (only if score < 7; rewrite the post fixing the issues, same rules: hook first line, real numbers, plain text, closing question, 2-4 hashtags like #BTC# on the last line)}`;

function trendsForPrompt(trends, recentTopics) {
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
    recentTopicsToAvoid: recentTopics,
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

// Deterministic strategy when every provider fails: spotlight the strongest
// listed signal, else fall back to a plain market recap.
function fallbackStrategy(snap, trends) {
  const listed = trends.movers?.all;
  const hotTrending = (trends.trending || []).find((c) =>
    listed?.some((m) => m.symbol === `${c.symbol.toUpperCase()}USDT`)
  );
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
  const gainer = trends.movers?.gain?.[0] ||
    [...snap.tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent)[0];
  return {
    topic: `${gainer.symbol} momentum`,
    symbol: gainer.symbol,
    angle: 'the strongest gainer of the last 24h',
    format: 'market-recap',
    hook: `${gainer.symbol} leads the market ${gainer.priceChangePercent >= 0 ? '+' : ''}${gainer.priceChangePercent.toFixed(1)}% in 24h`,
    hashtags: [gainer.symbol.replace('USDT', ''), 'Crypto'],
  };
}

async function runEditor(snap, trends, recentTopics, config) {
  const user =
    `Decide this hour's post. Live market data: ${snapshotForPrompt(snap)}\n` +
    `Trend intelligence: ${trendsForPrompt(trends, recentTopics)}`;
  try {
    const { value, provider } = await runProviderChain(config, {
      system: EDITOR_SYSTEM,
      user,
      temperature: 0.7,
      retriesPerProvider: 0,
      validate: (raw) => {
        const obj = parseJsonLoose(raw);
        if (!obj.topic || !String(obj.topic).trim()) throw new Error('missing "topic"');
        return obj;
      },
    });
    const strategy = {
      topic: String(value.topic).trim(),
      symbol: String(value.symbol || 'NONE').trim().toUpperCase(),
      angle: String(value.angle || '').trim(),
      format: FORMATS.includes(value.format) ? value.format : 'market-recap',
      hook: String(value.hook || '').trim(),
      hashtags: firstHashtags(value.hashtags),
    };
    log(`agents: editor (${provider}) -> ${strategy.format} on ${strategy.symbol} "${strategy.topic}"`);
    return strategy;
  } catch (err) {
    warn(`agents: editor failed (${err.message}) - using deterministic strategy`);
    const strategy = fallbackStrategy(snap, trends);
    log(`agents: fallback strategy -> ${strategy.format} on ${strategy.symbol}`);
    return strategy;
  }
}

async function runWriter(strategy, snap, trends, config) {
  const user =
    `Write the post. Strategy JSON: ${JSON.stringify(strategy)}\n` +
    `Live market data: ${snapshotForPrompt(snap)}\n` +
    `Trend context: ${trendsForPrompt(trends, [])}`;
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

async function runCritic(post, strategy, snap, config) {
  if (!config.critic.enabled) return null;
  const user =
    `Score this draft. Intended format: ${strategy.format}. Topic: ${strategy.topic}.\n` +
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
async function generateViralPost(snap, trends, recentTopics, config) {
  const strategy = await runEditor(snap, trends, recentTopics, config);

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
  try {
    ({ post, provider } = await runWriter(strategy, snap, trends, config));
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

  const critic = await runCritic(post, strategy, snap, config);
  let finalPost = post;
  let score = critic ? critic.score : null;
  let criticNote = critic ? critic.issues : null;

  if (critic && score < config.critic.minScore && critic.revised) {
    log(`agents: score ${score} < ${config.critic.minScore} - using the critic's rewrite`);
    finalPost = critic.revised;
  }

  const meta = { strategy, score, provider, criticNote };
  return { title: finalPost.title, content: finalPost.content, meta, spotlightSnap };
}

module.exports = { generateViralPost };
