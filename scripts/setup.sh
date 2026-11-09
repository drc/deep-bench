#!/usr/bin/env bash
# First-time setup after cloning. Safe to re-run — skips what already exists.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/4 Installing dependencies (wrangler for Cloudflare)"
npm install --no-audit --no-fund

echo "==> 2/4 Dataset check"
if [ -f public/dataset.json ]; then
  echo "    public/dataset.json present ($(du -h public/dataset.json | cut -f1)) — no data work needed"
else
  echo "    dataset.json missing — fetching raw NFL rosters 2002-2025 (~258 MB) and building"
  for y in $(seq 2002 2025); do
    [ -f data/roster_weekly_$y.csv ] || curl -sL -o data/roster_weekly_$y.csv \
      "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_$y.csv"
  done
  python3 build_data.py
fi

echo "==> 3/4 Unit tests"
node --test test/game.test.js

echo "==> 4/4 Next steps"
if npx wrangler whoami >/dev/null 2>&1; then
  echo "    wrangler: logged in ✓"
  echo "    Deploy now:            bash scripts/cf-setup.sh"
else
  echo "    wrangler: not logged in"
  echo "    Run:  npx wrangler login       (one-time, opens browser)"
  echo "    Then: bash scripts/cf-setup.sh (creates D1, secrets, deploys)"
fi
echo ""
echo "    Local dev instead: cp .dev.vars.example .dev.vars"
echo "                       npx wrangler d1 migrations apply deep-bench-db --local && npx wrangler dev"
