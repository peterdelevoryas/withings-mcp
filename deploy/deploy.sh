#!/usr/bin/env bash
# Ship the current checkout to the server, build it there, and restart. Usage: deploy/deploy.sh [ssh-host]
set -euo pipefail
HOST="${1:-root@withings.pjd.dev}"
cd "$(dirname "$0")/.."

rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .git --exclude .env --exclude .npm ./ "$HOST:/opt/withings-mcp/"
ssh "$HOST" bash -se <<'REMOTE'
set -euo pipefail
cd /opt/withings-mcp
chown -R withings:withings /opt/withings-mcp
sudo -u withings npm ci --no-audit --no-fund --loglevel=error
sudo -u withings npm run build --silent
sudo -u withings npm prune --omit=dev --no-audit --no-fund --loglevel=error
install -m 644 deploy/withings-mcp.service /etc/systemd/system/withings-mcp.service
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable withings-mcp >/dev/null
systemctl restart withings-mcp
systemctl reload-or-restart caddy
sleep 1
systemctl is-active withings-mcp && curl -fsS http://127.0.0.1:3000/healthz && echo
REMOTE
