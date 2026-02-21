# Recall Bridge Service

Express service that receives Recall.ai webhook events and forwards transcript-driven copilot prompts into OpenClaw via `/hooks/wake`.

## Features

- Recall bot launch endpoint (`/launch`)
- Recall webhook receiver (`/webhook`)
- Copilot control endpoints (`/copilot/*`, `/mute`, `/unmute`, `/meetverbose/*`)
- Meeting canvas endpoints (`/meeting/*`)
- Cloudflared quick tunnel manager (auto-managed)
- Duplicate webhook suppression via event-id cache

## Quick Start

```bash
cp .env.example .env
# fill required vars
set -a; source ./.env; set +a
npm install
npm start
```

## Required Environment Variables

- `RECALL_API_KEY`
- `RECALL_API_BASE` (e.g. `https://us-east-1.recall.ai`)
- `WEBHOOK_SECRET`

## Optional Environment Variables

- `CLOUDFLARED_BIN` (default `cloudflared`)
- `BRIDGE_API_TOKEN` (enables bearer auth on control routes)
- `OPENCLAW_CONFIG_PATH` (custom OpenClaw config path)

## Legacy Config Guard

Bridge startup fails fast when legacy config is detected (`WEBHOOK_BASE_URL`, Tailscale/ngrok remnants):

```text
Old config detected. Run `npx clawpilot setup --fresh` to reconfigure.
```

## Quick Tunnel Behavior

- Bridge launches `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<PORT>`.
- Tunnel URL is ephemeral per bridge runtime (`*.trycloudflare.com`).
- `/launch` fails fast if tunnel is not ready.
- If tunnel process dies, bridge auto-restarts it with bounded backoff and logs warning that active bots may need relaunch.

## Health Endpoint

`GET /health` includes:

- `tunnel.up`
- `tunnel.public_url`
- `tunnel.generation`
- `tunnel.last_error`
- webhook id cache stats (`webhook_event_cache.*`)

## Bridge API Auth

When `BRIDGE_API_TOKEN` is set, these routes require `Authorization: Bearer <BRIDGE_API_TOKEN>`:

- `POST /launch`
- `GET /copilot/status`
- `POST /mute`
- `POST /unmute`
- `POST /meetverbose/on`
- `POST /meetverbose/off`
- `GET /copilot/mode`
- `POST /copilot/mode`
- `GET /copilot/privacy`
- `POST /copilot/audience`
- `POST /copilot/reveal`
- `GET /meeting`
- `GET /meeting/state`
- `GET /meeting/stream`

## Webhook Security + Idempotency

- `/webhook` validates query token against `WEBHOOK_SECRET`.
- Duplicate events are ignored using in-memory event-id cache (TTL + max-size bounded).
- Cache resets on bridge restart.

## Preflight Check

```bash
../../scripts/require-cloudflared-quick-tunnel.sh
```

## launch-bot.sh

`launch-bot.sh` now calls local bridge `/launch` directly. It no longer builds external webhook URLs itself.
