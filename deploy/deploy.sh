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
pm2 reload deploy/ecosystem.config.cjs --update-env

echo "==> done"
pm2 status versely-mcp
