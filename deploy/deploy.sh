#!/usr/bin/env bash
# Ship the current checkout to the server, build it there, and restart. Usage: deploy/deploy.sh [ssh-host]
set -euo pipefail
# The server's private IP: it has no public address, and the domain points at
# the edge (ssh goes through it with a ProxyJump in ~/.ssh/config).
HOST="${1:-root@10.0.0.11}"
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
install -d -m 0750 -o root -g withings /etc/withings-mcp
[ -f /etc/withings-mcp/tokens ] || install -m 0640 -o root -g withings /dev/null /etc/withings-mcp/tokens
ufw allow from 10.0.0.0/16 to any port 3000 proto tcp >/dev/null
systemctl daemon-reload
systemctl enable withings-mcp >/dev/null
systemctl restart withings-mcp
sleep 1
systemctl is-active withings-mcp && curl -fsS http://10.0.0.11:3000/healthz && echo
REMOTE
