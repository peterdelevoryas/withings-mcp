#!/usr/bin/env bash
# Mint a long-lived bearer token for a client that can't do the OAuth flow (e.g.
# a headless agent), acting as the Withings account already connected on the
# server. The server keeps only the token's hash, in /etc/withings-mcp/tokens;
# the token goes into the macOS keychain (service withings-mcp-token, account =
# source). Revoke by deleting its line from that file; no restart needed.
#
# Usage: deploy/token.sh <source> [ssh-host]
# Read it back: security find-generic-password -s withings-mcp-token -a <source> -w
set -euo pipefail
[ $# -ge 1 ] || { sed -n 's/^# \{0,1\}//; 2,9p' "$0" >&2; exit 2; }
source=$1
HOST="${2:-root@10.0.0.11}"
[[ $source =~ ^[A-Za-z0-9_-]+$ ]] || { echo "source must be a single word, e.g. agent" >&2; exit 1; }
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
token_hash=$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)
ssh "$HOST" bash -s -- "$source" "$token_hash" <<'REMOTE'
set -euo pipefail
source=$1 token_hash=$2
userid=$(node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/var/lib/withings-mcp/withings-mcp.db", { readOnly: true });
  const rows = db.prepare("SELECT userid FROM withings_tokens").all();
  if (rows.length !== 1) { console.error(`expected one connected Withings account, found ${rows.length}`); process.exit(1); }
  console.log(rows[0].userid);
')
echo "$token_hash $source $userid" >> /etc/withings-mcp/tokens
REMOTE
security add-generic-password -U -s withings-mcp-token -a "$source" -w "$token"
echo "minted token for $source; stored in keychain (withings-mcp-token / $source)" >&2
