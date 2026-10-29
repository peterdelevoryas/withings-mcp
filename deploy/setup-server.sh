#!/usr/bin/env bash
# One-time (idempotent) server setup for Ubuntu 24.04.
# Usage: ssh root@<ip> DOMAIN=withings.pjd.dev bash -s < deploy/setup-server.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"

# The server has no public address: Hetzner gives it no default route and no
# DNS, so send its traffic through the network gateway to the edge's NAT.
iface=$(ip -o -4 addr show to 10.0.0.0/16 | awk '{print $2; exit}')
printf 'network:\n  version: 2\n  ethernets:\n    %s:\n      routes:\n      - to: default\n        via: 10.0.0.1\n        on-link: true\n      nameservers:\n        addresses: [185.12.64.1, 185.12.64.2]\n' "$iface" > /etc/netplan/60-edge-nat.yaml
chmod 600 /etc/netplan/60-edge-nat.yaml
netplan apply

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq curl gnupg ufw unattended-upgrades rsync debian-keyring debian-archive-keyring apt-transport-https

# Node.js 24 LTS
if ! node --version 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -yq nodejs
fi

# Firewall: SSH, and the app's port from the private network, where the edge
# server's Caddy terminates HTTPS and proxies to it.
ufw allow OpenSSH
ufw allow from 10.0.0.0/16 to any port 3000 proto tcp
ufw --force enable

# Key-only SSH
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd || true

id withings >/dev/null 2>&1 || useradd --system --home /opt/withings-mcp --shell /usr/sbin/nologin withings
mkdir -p /opt/withings-mcp

if [ ! -f /etc/withings-mcp.env ]; then
  cat > /etc/withings-mcp.env <<ENV
PUBLIC_URL=https://${DOMAIN}
WITHINGS_CLIENT_ID=
WITHINGS_CLIENT_SECRET=
DEFAULT_TIMEZONE=America/Los_Angeles
UNITS=imperial
# Comma-separated Withings user ids. Empty = first account to connect becomes the owner.
ALLOWED_WITHINGS_USERIDS=
ENV
  chmod 600 /etc/withings-mcp.env
fi

echo "Server setup done."
