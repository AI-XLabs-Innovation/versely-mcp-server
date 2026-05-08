#!/usr/bin/env bash
# Run on the droplet to deploy the latest code.
#   ssh user@droplet
#   cd ~/apps/versely-mcp
#   ./deploy/deploy.sh
#
# Pulls latest, installs deps, builds, and reloads PM2 (zero-downtime).

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> git pull --ff-only"
git pull --ff-only

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> pm2 reload (zero-downtime)"
if pm2 reload deploy/ecosystem.config.cjs --update-env 2>/dev/null; then
  echo "✅ pm2 reload succeeded"
else
  echo "⚠️  pm2 reload failed — doing fresh start"
  pm2 delete versely-mcp 2>/dev/null || true
  pm2 start deploy/ecosystem.config.cjs
fi

echo "==> done"
pm2 status versely-mcp
