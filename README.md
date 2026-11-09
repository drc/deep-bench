# Deep Bench — NFL Rarity Trivia demo

Krillion/Farflung-style daily questions where **rare answers win**. Three question types:

1. **Team + Position → player** — "Name a QB who played for the Buccaneers." (Brady = common, Freeman = rarer)
2. **Team + Number → player** — "Name a player who wore #99 for the Bears."
3. **Player → fewest-tenure team** — "Rivers played for the Chargers & Colts. Which did he spend FEWEST seasons with?"

## Data

- Source: nflverse weekly rosters (`data/roster_weekly_*.csv`, 2002–2025, ~258 MB),
  fetched via `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_<year>.csv`
- Filtered to active-roster statuses only (ACT/INA/RES — no practice squad / cuts)
- Relocations merged: SD→LAC, OAK→LV, STL→LAR, legacy codes ARZ/BLT/CLV/HST/SL
- Built into `public/dataset.json` (~3 MB): 12,134 players, 416 team+position
  groups, 3,053 team+number groups, 6,385 multi-team players

## Decisioning: typesafe/jev-router

The local roster DB grades answers instantly with a fame-based heuristic
(career seasons + draft capital). **jev-router** (OpenRouter `typesafe/jev-router`)
is the decisioning layer on top:

- **Adjudication** — answers outside the dataset (pre-2002 players like Dan
  Hampton or Vinny's Bucs years, odd stints) are judged valid/invalid + tiered
- **Tiering** — candidate lists can be tiered by fan-popularity (common/uncommon/rare)

Set a key: paste it in the demo's **jev Settings** tab (stored server-side in
`data/.jevkey`), or `export OPENROUTER_API_KEY=…` before starting. Verdicts are
cached in `data/jev-cache.json`.

## Run

```bash
python3 build_data.py        # rebuild dataset from CSVs (only if data changes)
node server.js               # listens on 127.0.0.1:4310
tailscale serve --bg --http=443 4310   # tailnet: https://oracle.tail72fd3b.ts.net
tailscale serve --bg --http=80 4310    # plain-http fallback
```

Pages: Daily Questions · Lookup Bench (interrogate any question) · Feasibility
stats · jev Settings.

## Known demo limitations

- Pre-2002 coverage (so answers like Vinny-as-Buc need jev adjudication)
- Heuristic tiers are a proxy; jev tiering is the real popularity signal
- Live answer distribution ("picked %") is in-memory, resets on restart
