# Binance Square Autoposter

Fully automatic AI bot. Every hour a **4-stage agent pipeline** runs:

1. **Scout** — pulls live Binance market data (BTC, ETH, SOL, BNB, XRP) plus trend signals: CoinGecko trending coins, the crypto Fear & Greed Index, top 24h gainers/losers/volume across all liquid USDT pairs, and (optional) CryptoPanic news headlines.
2. **Editor agent** — decides this hour's play as structured JSON: which coin, which angle, which format (market recap / trending spotlight / sentiment take / education / question), and a hook — never repeating a topic used in the last 12 hours.
3. **Writer agent** — turns the strategy into a viral-style post: number-led hook first line, plain text, closing question CTA, Binance-format hashtags. Title ≤70 chars and body 350–800 chars are enforced in code.
4. **Critic agent** — scores the draft 1–10 on hook, specificity, emotion and CTA. Below-threshold drafts get rewritten once; if they still score low, the hour is skipped (unless the account has been silent > `GATE_GRACE_HOURS` — then the best draft goes out anyway).
5. Renders 2–3 chart images (1h candlestick, 24h movers, plus a spotlight chart when the editor picked a Binance-listed trending coin), uploads them, and **publishes to Binance Square**.

AI providers are tried in order (Groq → OpenRouter → Gemini); every trend source and every agent degrades gracefully, so a failing dependency never stops the bot.

Runs headless on Render — no UI, no interaction needed. Health/status is served on `/`.

## Deploy to Render (one time, ~5 minutes)

1. Push this folder to a GitHub repo.
2. On [dashboard.render.com](https://dashboard.render.com): **New → Web Service** → connect the repo.
3. Runtime: **Node**, build command `npm install`, start command `npm start`.
4. Under **Environment → Environment Files**, add the contents of `.env` (or add each variable manually). Make sure `DRY_RUN=false`.
5. Deploy. The first post fires ~15 seconds after boot; then every hour on the hour (UTC). Watch the logs for `square: POSTED ...`.

## Keeping Render awake 24/7 (free)

Render's **free plan sleeps a service after ~15 minutes without inbound traffic**, which would pause the hourly posting. Nothing running inside the app can prevent this (a sleeping process can't ping itself) — the fix is an external ping every 10 minutes so Render never reaches its idle timeout. Two ways, either one alone is enough:

**Option A — GitHub Actions (already included, no extra account)**
1. Push this repo to GitHub and deploy on Render.
2. Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `RENDER_URL`, value `https://YOUR-APP.onrender.com`.
3. The included `.github/workflows/keep-alive.yml` now pings `/healthz` every 10 minutes, keeping Render awake around the clock. Test it with the "Run workflow" button on the Actions tab.

Caveat: GitHub auto-disables scheduled workflows after 60 days with no commits (it emails you first); any commit re-enables it. On a private repo the pings fit inside the free minutes tier; public repos are unlimited.

**Option B — cron-job.org (permanent, ~2 minutes, never expires)**
1. Free account at [cron-job.org](https://cron-job.org) → **Create cronjob**.
2. URL: `https://YOUR-APP.onrender.com/healthz`, schedule: every 10 minutes. Done.

The bot is also safe around sleep/restarts: on wake it posts a catch-up, and a built-in minimum gap (`POST_MIN_GAP_MINUTES`, default 55) guarantees it never double-posts within the hour.

**Paid alternative:** a Render Starter plan ($7/mo) or Background Worker never sleeps and needs no pinger at all.

## Local test (no posting)

```bash
npm install
npm run once            # generate text + images only, prints file paths
npm run once:upload     # also uploads images to Binance, but does not publish
```

Check one of the generated PNGs to see exactly what gets attached to each post.

## Configuration (.env)

| Variable | Meaning |
| --- | --- |
| `BINANCE_SQUARE_OPENAPI_KEY` | Square OpenAPI key from [Creator Center](https://www.binance.com/square/creator-center/home). If posting fails with code 220003/220004, generate a fresh key there. |
| `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` | AI text providers, tried in that order; a built-in template is the last fallback so posting never stops. |
| `POST_SCHEDULE_CRON` | Posting schedule, default `0 * * * *` (hourly, UTC). |
| `POST_SYMBOLS` / `MAIN_SYMBOL` | Coins tracked in every post / coin for the main chart. |
| `DRY_RUN` | `false` = post for real. `true` = generate only. `upload` = upload images but skip publishing. |
| `CRYPTOPANIC_API_KEY` | Optional free token from [cryptopanic.com/developers/api](https://cryptopanic.com/developers/api/) — adds hot news headlines to the scout. Works without it. |
| `CRITIC_ENABLED` / `CRITIC_MIN_SCORE` | Quality gate. `true` / `7` = drafts scoring below 7 are rewritten, then skipped while the account posts regularly. |
| `GATE_GRACE_HOURS` | After this many hours without a successful post, a below-threshold draft is published anyway (default 4 — an idle account is worse than an imperfect post). |
| `SPOTLIGHT_CHART` | `true` (default) renders a third candlestick chart for the coin the editor spotlights. |

## API used

Official Binance Square OpenAPI (same contract as Binance's own `square-post` skill):
`/image/presignedUrl` → S3 PUT → `/image/imageStatus` → `/content/add` with `contentType: 1` and `imageList`, authenticated via the `X-Square-OpenAPI-Key` header.

Limits: 100 posts/day, 400 uploads/day — an hourly cadence uses 24/48, well within limits.

## Status endpoint

`GET /` returns JSON: last run result, post link, total posts, next scheduled run, plus `lastPost` (topic, format, critic score, provider, post ID) and `trendsAt` (when trend data was last gathered). `GET /healthz` for uptime pings.

## Honest limits

Binance Square exposes no engagement-metrics API, so the bot can't learn from likes/views directly — quality control is the critic agent plus topic rotation from post history. No engagement-bait or spam tactics: the reach lever is content quality.
