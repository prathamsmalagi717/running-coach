# Strava connector for Claude

The running-coach skill, as a connector that works on claude.ai and the Claude mobile apps. A remote MCP server that lets Claude read your Strava data, on claude.ai, the Claude mobile apps and Claude Desktop. It uses only Strava's [official API](https://developers.strava.com/docs/reference/), signs you in with Strava's own login page, and is read-only: it cannot post, edit or delete anything.

It runs on Cloudflare Workers (the free plan is enough).

## What Claude can do with it

| Tool | What it returns |
| --- | --- |
| `get_athlete` | Your profile, units preference, weight, FTP, bikes and shoes |
| `get_athlete_stats` | Last 4 weeks, year-to-date and all-time totals for runs, rides and swims |
| `list_activities` | Activities in a date range, filterable by sport, with distance, time, pace/speed, HR and power |
| `get_training_summary` | This week, last week, this month and last month: runs, km, time, average pace, longest run |
| `get_activity` | One activity in full: description, km splits, laps, best efforts, segment efforts, gear, calories |
| `get_activity_streams` | Second-by-second HR, pace, power, cadence, elevation or GPS, downsampled |
| `get_activity_zones` | Time in HR/power zones (Strava provides this to subscribers only) |
| `get_athlete_zones` | Your HR and power zone settings |
| `list_starred_segments`, `get_segment` | Segments with your PR and effort count |
| `explore_segments` | Popular segments inside a map area |
| `list_segment_efforts` | Your attempts on a segment (Strava provides this to subscribers only) |
| `list_clubs`, `list_routes`, `get_gear` | Clubs, saved routes, and a bike or pair of shoes |

It also includes a **Running coach** prompt with the same coaching guidance as `SKILL.md`. Pick it from the prompts menu in a chat to get answers in coach mode.

Things to ask Claude once it's connected: "How did my running volume this month compare to last month?", "Show my last 5 rides with average power", "What was my heart rate doing in the second half of yesterday's run?"

## Setup (about 15 minutes, on a computer)

You need [Node.js](https://nodejs.org) 20 or newer, a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a Strava account.

### 1. Deploy the server

```bash
git clone https://github.com/prathamsmalagi717/running-coach && cd running-coach/mcp-server
npm install
npx wrangler login                          # opens Cloudflare in your browser
npx wrangler kv namespace create OAUTH_KV   # prints an id
```

Paste the printed `id` into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_KV_ID`, then deploy:

```bash
npm run deploy
```

Wrangler prints your server's address, something like `https://strava-mcp.<your-name>.workers.dev`. Keep it handy.

### 2. Connect your Strava API app

This reuses the Strava app you already created for the running-coach skill (see `../SETUP.md`).

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and click **Edit** on your app.
2. Change **Authorization Callback Domain** from `localhost` to your server's host, without `https://`, for example `strava-mcp.your-name.workers.dev`, and save. Strava always allows `localhost` too, so `scripts/strava_auth.py` and your daily schedule keep working.
3. Give the server the app's **Client ID** and **Client Secret**, which are also in `../data/strava_credentials.json`:

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
```

New Strava apps start out limited to one athlete (you), so nobody else can connect their Strava through your server.

### 3. Add it to Claude

1. On [claude.ai](https://claude.ai), open **Settings → Connectors → Add custom connector**.
2. Name it `Strava` and enter your server address followed by `/mcp`, for example `https://strava-mcp.your-name.workers.dev/mcp`.
3. Click **Connect**, approve, then log in to Strava and click **Authorize**. Leave all the boxes ticked, because the activity permissions are what make it useful.

The connector then shows up in the Claude mobile apps too. Enable it from the tools menu in a chat.

### Optional: lock it to your account

To refuse every Strava account except yours, find your athlete id (the number in your Strava profile URL) and add it to `wrangler.jsonc`:

```jsonc
"vars": { "ALLOWED_ATHLETE_IDS": "12345678" }
```

Then run `npm run deploy` again.

## How it works

```
Claude ──OAuth 2.1──▶ this Worker ──Strava OAuth──▶ Strava login
Claude ──/mcp + token──▶ this Worker ──Strava API (your token)──▶ strava.com
```

- The Worker is an OAuth server for Claude (dynamic client registration, PKCE, consent page) built on [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), and it signs you in through Strava.
- Your Strava tokens are stored encrypted inside Claude's token grant. The Worker keeps no database of activities.
- Strava access tokens last 6 hours. Claude's tokens are issued to expire just before the Strava token inside them, and each refresh also refreshes Strava, so the connection keeps working without logging in again. If you revoke the app on Strava, the grant is revoked too and Claude asks you to reconnect.
- Strava's default limit is 200 requests per 15 minutes and 2,000 per day. If Claude hits it, the tool says so instead of failing silently.

## Development

```bash
npm run type-check
npm test        # full OAuth + MCP flow against a local Worker and a fake Strava, no account needed
npm run dev     # local server on http://localhost:8788 (put STRAVA_CLIENT_ID/SECRET in .dev.vars)
```

Source: `src/index.ts` (OAuth provider and MCP endpoint), `src/auth-handler.ts` (consent page and Strava login), `src/tools.ts` (tools), `src/strava.ts` (API client and formatting).

## Strava's terms

This uses your own data through your own API app, which Strava's [API Agreement](https://www.strava.com/legal/api) allows. Don't use it to show your data to other people's apps, or to share other athletes' data.
