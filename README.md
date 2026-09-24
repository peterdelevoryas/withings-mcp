# withings-mcp

A remote MCP server that gives Claude read access to your Withings data: weight and body composition, blood pressure, sleep, daily activity, workouts, ECGs, and devices.

Claude connects over Streamable HTTP with OAuth. Signing in to the server *is* the Withings consent screen: when you add the connector, you're sent to Withings, you approve, and the server stores your Withings tokens (refreshing them automatically) and hands Claude its own token. Only the owner's Withings account can connect: the first account to connect, or the ids in `ALLOWED_WITHINGS_USERIDS`.

## Tools

| Tool | Data | Default range |
|---|---|---|
| `get_measurements` | weight, fat/muscle/bone/water, visceral fat, BP, heart rate, SpO2, temperature, VO2 max, ECG intervals… | 30 days |
| `get_sleep` | sleep score, stages, efficiency, latency, HR, RR, HRV, snoring, breathing disturbances | 7 days |
| `get_activity` | steps, distance, floors, activity minutes, calories, HR zones | 7 days |
| `get_workouts` | type, duration, calories, HR, distance, laps | 30 days |
| `get_heart_recordings` | ECG AFib classification + BP/HR from the same recording | 90 days |
| `get_devices` | model, battery, last sync | – |

All ranged tools take optional `start_date` / `end_date` (`YYYY-MM-DD`, inclusive).

## Development

```sh
npm install
npm test          # e2e: real server + fake Withings API, full OAuth + MCP flow
npm run typecheck
```

## Configuration

| Variable | |
|---|---|
| `PUBLIC_URL` | Public origin, e.g. `https://withings.pjd.dev` (OAuth issuer; Withings callback is `$PUBLIC_URL/withings/callback`) |
| `WITHINGS_CLIENT_ID` / `WITHINGS_CLIENT_SECRET` | From the Withings developer dashboard |
| `ALLOWED_WITHINGS_USERIDS` | Optional comma-separated allowlist. Empty: first account to connect is locked in as owner |
| `DEFAULT_TIMEZONE` | For interpreting dates (default `America/Los_Angeles`) |
| `DB_PATH`, `PORT`, `HOST` | SQLite path, listen address |

## Deployment (Hetzner)

1. Create a Withings app at <https://developer.withings.com/dashboard/> with callback URL `https://withings.pjd.dev/withings/callback`.
2. Create an Ubuntu 24.04 server with your SSH key, then point an `A` record for `withings.pjd.dev` at it.
3. First deploy:
   ```sh
   ssh root@<ip> DOMAIN=withings.pjd.dev bash -s < deploy/setup-server.sh   # Node, Caddy, firewall, user, env file
   ssh root@<ip> 'nano /etc/withings-mcp.env'                                 # fill in client id/secret
   deploy/deploy.sh root@<ip>
   ```
4. Subsequent deploys: `deploy/deploy.sh`.
5. In Claude: Settings → Connectors → Add custom connector → `https://withings.pjd.dev/mcp`.
   In Claude Code: `claude mcp add --transport http withings https://withings.pjd.dev/mcp`.

Logs: `ssh root@withings.pjd.dev journalctl -u withings-mcp -f`
