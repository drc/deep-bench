#!/usr/bin/env bash
# First-time Cloudflare setup for Deep Bench. Idempotent-ish; safe to re-run.
# Requires: node 20+, npm, and `npx wrangler login` completed once.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1. Checking wrangler auth"
npx wrangler whoami >/dev/null 2>&1 || { echo "Not logged in. Run: npx wrangler login"; exit 1; }

echo "==> 2. Creating D1 database (skipped if it exists)"
DB_ID=$(npx wrangler d1 list 2>/dev/null | grep -oE '[0-9a-f-]{36} .*deep-bench-db' | grep -oE '^[0-9a-f-]{36}' || true)
if [ -z "$DB_ID" ]; then
  DB_ID=$(npx wrangler d1 create deep-bench-db 2>&1 | grep -oE '[0-9a-f-]{36}' | head -1)
  echo "    created: $DB_ID"
else
  echo "    exists: $DB_ID"
fi

echo "==> 3. Writing database_id into wrangler.jsonc"
if grep -q "REPLACE_ME" wrangler.jsonc; then
  sed -i.bak "s/REPLACE_ME/$DB_ID/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "    wrangler.jsonc updated"
else
  echo "    already configured"
fi

echo "==> 4. Applying migrations to remote D1"
npx wrangler d1 migrations apply deep-bench-db --remote

echo "==> 5. Secrets (prompted; values never touch this script)"
echo "    COOKIE_SECRET — random string for signing player cookies"
if ! npx wrangler secret list 2>/dev/null | grep -q COOKIE_SECRET; then
  npx wrangler secret put COOKIE_SECRET
fi
if ! npx wrangler secret list 2>/dev/null | grep -q OPENROUTER_API_KEY; then
  echo "    OPENROUTER_API_KEY — optional: enables jev-router long-tail adjudication"
  read -r -p "Set OPENROUTER_API_KEY now? [y/N] " yn
  [ "${yn:-N}" = "y" ] && npx wrangler secret put OPENROUTER_API_KEY
fi

echo "==> 6. Deploying"
npx wrangler deploy

echo ""
echo "Done. Your Worker URL is in the deploy output (https://deep-bench.<your-subdomain>.workers.dev)."
echo "Play: open it on your phone, answer 5, kick the FG."
