# Binance Square Autoposter

Fully automatic AI bot. Every hour it:

1. Pulls live market data from Binance (BTC, ETH, SOL, BNB, XRP).
2. Writes a fresh post with AI (Groq, with OpenRouter and Gemini as fallbacks).
3. Renders two chart images (1h candlestick chart + 24h movers).
4. Uploads the images and **publishes the post to Binance Square** (with images, always).

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

## API used

Official Binance Square OpenAPI (same contract as Binance's own `square-post` skill):
`/image/presignedUrl` → S3 PUT → `/image/imageStatus` → `/content/add` with `contentType: 1` and `imageList`, authenticated via the `X-Square-OpenAPI-Key` header.

Limits: 100 posts/day, 400 uploads/day — an hourly cadence uses 24/48, well within limits.

## Status endpoint

`GET /` returns JSON: last run result, post link, total posts, next scheduled run. `GET /healthz` for uptime pings.
