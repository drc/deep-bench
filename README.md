# Deep Bench 🏈

[![CI](https://github.com/drc/deep-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/drc/deep-bench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-26-green)
![python](https://img.shields.io/badge/python-3.12+-yellow)

Krillion-style NFL rarity trivia: every question has many correct answers, and
**the rarer your answer, the more yards you gain**. Five questions per drive —
a mixed bag of team+position and team+number — then you line up for a field
goal. Great answers put you inside the 20, lazy ones leave you staring at a
62-yarder that probably won't make it.

## The Drive

Five questions, one at a time: **team+position** ("Name a QB who played for
the Buccaneers") and **team+number** ("Who wore #99 for the Bears") in a mixed
bag — 2–3 position, 3–2 number per drive.

Each answer is a play:

| Answer rarity | Yards |
|---|---|
| 🟡 deep *(superfans only)* | **+14** |
| 🟣 rare | +12 |
| 🔵 uncommon | +9 |
| 🟠 common | +6 |
| 🔴 miss | +0 |

Ball starts at your own 25. Perfect play (5 deep) gains 70 yards and lands at
the opponent's 5 — a chip shot. Then kick: distance = yards-to-goal + 17,
with NFL-accurate make odds (27-yd ≈ 96%, 45-yd ≈ 70%, 55+ ≈ 40%, 65+ ≈ 12%).
**Made field goal = 3 points.**

Pick a team edition (Bears ★ by default) to scope all questions to your squad.

## Decisioning: typesafe/jev-router

Two layers grade answers:

1. **Roster database** (instant, free) — built from nflverse weekly rosters,
   2002–2025. Grades valid answers, fuzzy-matches last names, and scores
   rarity from a fame proxy (career seasons + draft capital).
2. **[jev-router](https://openrouter.ai/typesafe/jev-router)** (OpenRouter) —
   adjudicates everything outside the dataset: pre-2002 deep cuts (Dan Hampton
   wore #99 for the Bears; Vinny Testaverde really was a Bucs QB), odd stints,
   and near-miss names. Assigns the common/uncommon/rare tier and explains its
   verdict. Verdicts cache to `data/jev-cache.json`.

The roster DB's coverage window is not a trivia constraint — jev judges
franchise history all-time, which is what the game wants.

**Secrets:** the OpenRouter key lives in `data/.jevkey` (or `OPENROUTER_API_KEY`),
which is gitignored and never committed. CI runs a secret-scan on every push.

## Quickstart

Tasks are run with [mise](https://mise.jdx.dev) (`mise trust` once, then):

```bash
mise run data     # optional: fetch raw CSVs (2002–2025, ~258 MB)
mise run build    # rebuild dataset.json (prebuilt copy is committed)
mise run serve    # demo on http://127.0.0.1:4310
mise run smoke    # boot + API smoke test
mise run tunnel   # expose on your tailnet
```

No mise? `node server.js` works the same. A prebuilt `public/dataset.json` is
committed, so cloning → serving requires zero data work.

## Data

- Source: [nflverse weekly rosters](https://github.com/nflverse/nflverse-data)
  2002–2025, filtered to active-roster statuses (ACT/INA/RES — no practice
  squad or offseason cuts)
- Relocations merged (SD→LAC, OAK→LV, STL→LAR; legacy codes ARZ/BLT/CLV/HST/SL)
- Built dataset: **12,134 players**, 416 team+position groups, 3,053
  team+number groups, 6,385 multi-team players (~3.9 MB JSON)

## Repo layout

```
build_data.py       CSVs -> dataset.json (dedupe, positions, fame scores)
server.js           zero-dep Node server: game engine, grading, jev calls
public/index.html   the whole UI (vanilla JS)
public/dataset.json committed prebuilt dataset
scripts/smoke.sh    boots server, plays a full drive, asserts the API
mise.toml           task runner
```

## API (demo surface)

| Endpoint | What |
|---|---|
| `POST /api/game/start {team}` | new 5-question drive |
| `POST /api/game/answer {gameId, answer}` | grade play, gain yards, get next question |
| `POST /api/game/kick {gameId}` | attempt the field goal |
| `GET /api/lookup?type=tp\|tn\|player&…` | lookup bench for interrogating questions |
| `GET /api/feasibility?team=` | question-pool stats |
| `POST /api/grade` | stateless single-question grading (daily mode) |

## Known limitations / roadmap

- Raw data starts at 2002 — pre-2002 answers rely on jev adjudication
- Heuristic fame tiers are a bootstrap; jev tiering is the real signal
- Game sessions and answer distribution are in-memory (restart = fresh)
- One player at a time; multi-player lobbies would be the next step
