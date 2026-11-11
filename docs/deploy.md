# Deploy Deep Bench from your laptop

Zero-config-creation deploy: clone, run one script, play.

## Prerequisites

- Node 20+
- A Cloudflare account (free tier is plenty)
- One-time: `npx wrangler login` (opens a browser)

## First deploy

```bash
git clone https://github.com/drc/deep-bench && cd deep-bench
npm install
bash scripts/cf-setup.sh
```

The script:

1. Verifies wrangler auth
2. Creates the D1 database (`deep-bench-db`) and wires its id into `wrangler.jsonc`
3. Applies the schema (`migrations/0001_init.sql`) remotely
4. Prompts for secrets — `COOKIE_SECRET` (required, random string) and
   `OPENROUTER_API_KEY` (optional, enables jev-router long-tail adjudication).
   Secrets go to Cloudflare's vault, never into git.
5. Deploys and prints your `workers.dev` URL

## Local development

```bash
cp .dev.vars.example .dev.vars   # then edit if you want jev locally
npx wrangler d1 migrations apply deep-bench-db --local
npx wrangler dev                 # http://localhost:8787 — real Worker, local D1
```

## Redeploys

```bash
npx wrangler deploy
```

## What the Worker does differently from the Node demo

- **Cookie identity**: first visit mints an HMAC-signed player cookie. All
  history keys off it (clearing cookies = new player).
- **Team drives**: pick your team (defaults to the Bears) — questions scope to
  that team's pool, falling back to league-wide where a pool is too thin.
- **One drive per day**: `UNIQUE(player_id, game_date)` in D1 — starting a
  drive consumes the day; abandoned drives resume where you left off and
  unanswered plays score 0.
- **Same questions for everyone**: each day's first-play question set is
  snapshotted into the `daily_picks` table, so dataset updates never rewrite
  history.
- **jev-router verdicts** cache in D1 (`verdicts` table) — each deep-cut
  adjudication is paid for once, globally.

## Cost

Free tier covers ~12k players/day. D1 free: 5M row-reads/day.
