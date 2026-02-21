# ClawPilot

ClawPilot connects Recall.ai live transcripts to OpenClaw so your copilot can react in real time during meetings.

## Prerequisites

1. OpenClaw installed and working
2. OpenClaw model/channel auth already configured
3. Node.js 18+ on the bridge host
4. Recall.ai account and API key
5. `cloudflared` available (or install via `npx clawpilot setup`)

## Install ClawPilot Plugin

```bash
openclaw plugins install @clawpilot/clawpilot
openclaw daemon restart
openclaw plugins info clawpilot
```

## One-Click Setup (v1)

```bash
npx clawpilot setup
```

If setup reports legacy config drift, rerun:

```bash
npx clawpilot setup --fresh
```

Setup behavior:

1. Detects legacy Tailscale/ngrok config and fails fast unless `--fresh`.
2. Installs `cloudflared` (brew/apt when possible, user-local fallback otherwise).
3. Installs plugin, restarts OpenClaw daemon, verifies plugin load.
4. Prompts you to run `/clawpilot install` in chat for bridge auth/tunnel checks.

## Chat-Only Finalizer

After plugin install, run in chat:

```text
/clawpilot install
```

`/clawpilot setup` remains an alias in chat.

## Configure Bridge Runtime

```bash
./scripts/bootstrap-recall.sh
cd services/clawpilot-bridge
set -a; source ./.env; set +a
npm install
npm start
```

Required bridge env:

1. `RECALL_API_KEY`
2. `RECALL_API_BASE`
3. `WEBHOOK_SECRET`

Optional bridge env:

1. `CLOUDFLARED_BIN` (default `cloudflared`)
2. `BRIDGE_API_TOKEN` (recommended)
3. `OPENCLAW_CONFIG_PATH` (if bridge user differs)

Quick preflight:

```bash
./scripts/require-cloudflared-quick-tunnel.sh
RUN_VPS_AUTH_CHECK=true npm run qa:quick-checks
```

## Verify End-to-End

1. Local bridge health:
```bash
curl -s http://127.0.0.1:3001/health
```
2. Plugin loaded:
```bash
openclaw plugins info clawpilot
```
3. Chat checks:
```text
/clawpilot help
/clawpilot status
/clawpilot join https://meet.google.com/abc-defg-hij
```

## Components

1. `packages/clawpilot-plugin`: OpenClaw plugin (`/clawpilot` commands)
2. `packages/clawpilot-cli`: one-click setup CLI (`npx clawpilot setup`)
3. `services/clawpilot-bridge`: Recall webhook receiver + OpenClaw bridge
4. `scripts/require-cloudflared-quick-tunnel.sh`: quick-tunnel preflight check

## Security Notes

1. Bridge `/webhook` validates query token (`WEBHOOK_SECRET`).
2. Bridge control routes can require bearer auth via `BRIDGE_API_TOKEN`.
3. Plugin bridge calls are local-only in v1 (localhost/127.0.0.1/::1).
4. Webhook duplicate events are suppressed by in-memory event-id cache.

## Troubleshooting

1. `Old config detected...`:
   run `npx clawpilot setup --fresh`.
2. `Bridge is unreachable`:
   verify `openclaw plugins info clawpilot` and local bridge `/health`.
3. Tunnel not up:
   inspect `/health` `tunnel.*` fields and verify `cloudflared` is installed.
4. 401 errors:
   align plugin `bridgeToken` with `BRIDGE_API_TOKEN` and restart daemon.
