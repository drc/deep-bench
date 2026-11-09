# Cloudflare Workers migration plan

Goal: run Deep Bench on Cloudflare Workers with daily shared questions,
cookie-based player identity, persisted score history, and one drive per day.

## Product rules this plan encodes

1. **One drive per player per day.** Starting a drive consumes your day.
   Abandoned drives count: unanswered questions score 0, and you can return to
   finish the kick (state resumes). No restarts — restarts would let players
   brute-force the shared question set.
2. **Everyone gets the same 5 questions per day**, drawn deterministically from
   the question pools by date seed (mixed bag: 2–3 position, rest number).
3. **Cookie = player.** No signup. First visit mints an identity cookie; return
   visits resume history. Clearing cookies = new player (accepted for v1; named
   accounts/passkeys are a later upgrade).

## Architecture on Cloudflare

```
Browser ──HTTPS──▶ Worker (Hono or plain fetch handler)
                     ├─ Static Assets: index.html, share assets
                     ├─ dataset.json (bundled OR static asset, 487 KB gz)
                     ├─ D1 (SQLite): players, games, results
                     ├─ KV: jev verdict cache (long TTL)
                     └─ fetch: OpenRouter jev-router (secret key)
```

**Compute.** Single Worker. The existing game core (pools, `heuristicTiers`,
`grade`, `matchCandidate`, `matchMT`, yardage/FG math, daily seed) is already
pure JS with zero Node deps — it ports as-is. The zero-dep `http` server layer
is the only part replaced with a fetch handler / router.

**Dataset (3.0 MB raw / 487 KB gzip).** Bundle it into the Worker script —
well under the 3 MB compressed limit even with code. (Fallback: Workers
Static Assets + `env.ASSETS.fetch` if the bundle ever grows.)

**State: D1, not KV.** "Only play once" needs strong consistency — KV is
eventually consistent (replication lag can allow double-plays). D1 gives us
real constraints:

```sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,            -- uuid minted at first visit
  created_at TEXT NOT NULL,
  display_name TEXT               -- phase 2
);
CREATE TABLE games (
  player_id TEXT NOT NULL,
  game_date TEXT NOT NULL,        -- UTC date, e.g. 2026-11-09
  status TEXT NOT NULL,           -- active | kick | done
  state TEXT NOT NULL,            -- JSON: question ids, idx, log, yards
  UNIQUE (player_id, game_date)   -- ← the once-per-day rule, enforced
);
CREATE TABLE answers (           -- normalised per-play rows for analysis
  player_id TEXT NOT NULL, game_date TEXT NOT NULL,
  qid TEXT NOT NULL, answer TEXT, tier TEXT, yards INTEGER
);
```

**Daily questions, deterministic.** `seed = hash(game_date)` (the existing
mulberry32 approach). All edge nodes compute the identical set from the same
bundled dataset. On the first request of a new day, the chosen qid list is
inserted into a `daily_picks` table (idempotent) so a dataset update can never
retroactively change a day that people already played.

**Cookie identity.** On first `/api/*` request with no cookie, mint
`crypto.randomUUID()`, store in `players`, and set:

- `db_uid=<uuid>; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`
- `db_sig=HMAC-SHA256(uuid, COOKIE_SECRET); HttpOnly; Secure; SameSite=Lax`

Every request verifies the HMAC before touching D1. `COOKIE_SECRET` and
`OPENROUTER_API_KEY` are Workers Secrets (wrangler secret put) — never in git,
matching the repo's secret-scan policy.

**jev-router from Workers.** Same prompts, same model. Verdict cache moves to
KV (`jev:{qid}|{answer}`, 30-day TTL) so the long tail is paid for once
globally. Cache writes are best-effort; grading never blocks on cache failure.

## API surface (v1 on Workers)

| Route | Behavior |
|---|---|
| `GET /api/me` | identity + today's status: `not_started / in_progress / done`, plus full history (past drives: date, yards, FG result, points) |
| `POST /api/game/start` | 409 with today's recap if already played; else create `games` row and return play 1 |
| `POST /api/game/answer` | grade (DB + jev), update `games.state`, append `answers` |
| `POST /api/game/kick` | FG roll, mark `done`, return summary |
| `GET /api/recap/:date` | your recap for a past day (share-sheet text source) |
| `GET /api/leaderboard/:date` | phase 2: ranked results for the day |

Cookie is set on `start`/`me` responses if missing, so the very first answer
already counts for the right player.

## Edge cases called out

- **Timezone / "day" boundary**: UTC. A player at 11pm ET plays "today" and can
  play again 1 hour later — acceptable for v1; alternative is an ET boundary
  (day rolls 6am ET), noted as a tuning knob.
- **Abandoned drive**: `state` JSON persisted after every answer; returning
  player resumes at the exact play (or kick phase). Unanswered = 0 yards.
- **Mid-drive cookie loss**: game rows are keyed by player; a lost cookie after
  start orphans one row — worst case the player loses that day.
- **jev outage**: dataset grading always works; unresolvable long-tail answers
  return the standard "not found" miss.
- **Sharing**: existing Web Share flow unchanged; share text gains a stable
  recap URL (works logged out — recap pages are public read-only).

## Build phases

1. **Refactor for portability** — extract the game core from `server.js` into
   `lib/game.js` (pure), keep the Node demo running on the same module.
   Test: existing smoke script, plus unit tests on seed determinism.
2. **Worker skeleton** — wrangler project, bundle dataset, port routes 1:1
   (`game/start|answer|kick`), no identity yet. `wrangler dev` + current smoke
   test against it.
3. **Identity + once-per-day** — cookie mint/verify, D1 schema + UNIQUE
   enforcement, `/api/me` history, recap-on-replay.
4. **jev + KV cache** — OpenRouter fetch from Worker, KV verdicts.
5. **Ship** — custom domain (or workers.dev first), CI via `wrangler deploy`
   GitHub Action on main; keep the tailscale Node demo as staging.
6. **Phase 2 ideas** — leaderboards, streaks, named accounts, answer
   distribution stats (the "picked %" mechanic comes back with real users).

## Cost picture

Workers free tier: 100k requests/day (each drive ≈ 8 requests — ~12k
players/day). D1 free: 5M row-reads/day. jev-router: ~$0 while verdict cache
warms. Effectively free at hobby scale.
