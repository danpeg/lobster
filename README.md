# ClawPilot

Let your OpenClaw join meetings and actively participate: do research, come up with ideas, create assets as you go.

ClawPilot connects Recall.ai live transcripts to OpenClaw so your copilot can react in real time during meetings.

## Prerequisites

1. OpenClaw installed and working
2. OpenClaw model/channel auth already configured
3. Node.js 18+ on the bridge host
4. Recall.ai account and API key
5. Active Tailscale Funnel URL that routes to bridge (`https://<node>.ts.net`)

## Install ClawPilot Plugin

```bash
openclaw plugins install @clawpilot/clawpilot
openclaw daemon restart
openclaw plugins info clawpilot
```

## Configure Runtime (Required)

Bootstrap your env file:

```bash
./scripts/bootstrap-recall.sh
cd services/clawpilot-bridge
set -a; source ./.env; set +a
npm install
npm start
```

Bootstrap enforces Funnel alignment and fails fast unless:

1. `WEBHOOK_BASE_URL` is `https://*.ts.net`
2. Local bridge `/health` is reachable
3. Public Funnel `/health` reaches the same bridge

Required environment variables:

1. `RECALL_API_KEY`
2. `RECALL_API_BASE` (match your Recall workspace region)
3. `WEBHOOK_SECRET`
4. `WEBHOOK_BASE_URL` (required `https://*.ts.net` for supported install/reinstall/update)
5. `BRIDGE_API_TOKEN` (strongly recommended; bearer token for bridge control routes)

OpenClaw integration values are loaded from `openclaw.json`:

6. `hooks.*` (for `/hooks/wake` + token)
7. `channels.discord.botToken` (for direct Discord delivery)
8. If bridge runs as a different OS user, set `OPENCLAW_CONFIG_PATH` to the correct `openclaw.json`

Optional bridge behavior:

9. `DISCORD_DIRECT_DELIVERY` (default: `true`)

Routing is channel-agnostic by default (via OpenClaw hooks). Discord direct delivery is an optional reliability adapter with fallback to OpenClaw hooks.

Plugin auth alignment:

- Configure plugin `bridgeToken` to exactly match `BRIDGE_API_TOKEN` once bridge auth is enabled.
- Reinstall/reset can clear plugin config. Rerun bootstrap + auth checks after reinstall/update.

Quick preflight checks:

```bash
./scripts/require-tailscale-funnel.sh
RUN_VPS_AUTH_CHECK=true npm run qa:quick-checks
```

Private VPS deploy preflight flags (for `/Users/danpeguine/Projects/clawpilot-vps-cycle.sh`):

1. `BRIDGE_TOKEN_ENV_FILE` (token source)
2. `BRIDGE_WEBHOOK_ENV_FILE` (webhook/Funnel source; defaults to token env file)
3. `BRIDGE_AUTH_PREFLIGHT` (`true` by default; validates 401 unauth + 200 auth)

## Verify End-to-End

1. Bridge health:
```bash
curl -s http://127.0.0.1:3001/health
```
2. Plugin loaded:
```bash
openclaw plugins info clawpilot
```
3. In OpenClaw chat, run:
```text
/clawpilot help
```
4. Launch a meeting bot directly from chat:
```text
/clawpilot join https://meet.google.com/abc-defg-hij
```
Optional custom name:
```text
/clawpilot join https://meet.google.com/abc-defg-hij --name "Dan Note Taker"
```
Toggle transcript mirroring in active chat:
```text
/clawpilot transcript on
/clawpilot transcript off
```
Mode and privacy controls:
```text
/clawpilot mode
/clawpilot mode brainstorm
/clawpilot audience private
/clawpilot audience shared
/clawpilot privacy
/clawpilot reveal context
```
5. Confirm transcripts trigger copilot responses.

## Components

1. `packages/clawpilot-plugin`: npm-installable OpenClaw plugin (`/clawpilot` command)
2. `services/clawpilot-bridge`: Recall webhook receiver and OpenClaw hook bridge
3. `services/clawpilot-bridge/prompts/lobster.md`: editable meeting copilot prompt pack

## Security Notes

1. The plugin does not read environment variables at runtime.
2. The plugin only calls your configured bridge endpoint for explicit `/clawpilot` commands.
3. Non-private bridge hosts are blocked by default unless `allowRemoteBridge` is explicitly enabled.
4. `/launch` responses are sanitized and do not return webhook URLs or tokens.

## Branches

1. `main`: stable release path
2. `experimental`: active development, includes Notion and Google Docs integrations

## Release

1. Develop on `experimental`
2. Merge curated changes to `main`
3. Run checks:
   - `npm run security:scan`
   - `npm run check:plugin-pack`
4. Publish plugin package from `packages/clawpilot-plugin`

See `RELEASING.md` for full steps.

## Troubleshooting

1. `plugin not found`:
   restart OpenClaw daemon and run `openclaw plugins doctor`
2. No copilot reaction:
   verify bridge `.env` values and check bridge logs
3. Recall webhook failures:
   confirm `WEBHOOK_BASE_URL` is `https://*.ts.net` and run `./scripts/require-tailscale-funnel.sh`
4. Reinstall/update followed by 401 errors:
   re-sync plugin token and restart daemon
   `openclaw config set plugins.entries.clawpilot.config.bridgeToken "<BRIDGE_API_TOKEN>"`
   `openclaw daemon restart`
5. `ClawPilot command failed: fetch failed`:
   verify plugin bridge URL points to a running bridge and Funnel health is green:
   `openclaw config get plugins.entries.clawpilot.config.bridgeBaseUrl`
   `curl -s https://<node>.ts.net/health`
