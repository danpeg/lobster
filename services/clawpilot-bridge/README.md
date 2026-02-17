# Recall Bridge Service

Express service that receives Recall.ai webhook events and forwards transcript-driven copilot prompts into OpenClaw via `/hooks/wake`.

## Features

- Recall bot launch endpoint (`/launch`)
- Recall webhook receiver (`/webhook`)
- Copilot control endpoints (`/copilot/status`, `/mute`, `/unmute`, `/meetverbose/*`)
- No browser launcher UI; launch is API/chat-driven only
- Optional integrations on `experimental` branch:
  - Notion transcript mirroring
  - Google Docs helper scripts

## Quick Start

```bash
cp .env.example .env
# fill in required variables
set -a; source ./.env; set +a
npm install
npm start
```

## Required Environment Variables

- `RECALL_API_KEY`
- `RECALL_API_BASE` (region endpoint, e.g. `https://us-east-1.recall.ai` or `https://eu-central-1.recall.ai`)
- `WEBHOOK_SECRET`
- `WEBHOOK_BASE_URL`
- `OPENCLAW_HOOK_URL`
- `OPENCLAW_HOOK_TOKEN`

## Optional Bot Naming

- `OPENCLAW_AGENT_NAME` -> default bot name becomes `<OPENCLAW_AGENT_NAME> Note Taker`
- `RECALL_BOT_NAME` -> explicit override
- `RECALL_BOT_NAME_SUFFIX` -> defaults to `Note Taker`

## Reaction Style Defaults

- Reactions are final-transcript driven by default (`REACT_ON_PARTIAL=false`)
- Output is a single natural coaching line (no forced numbered format)
- Default proactivity is `high` for faster, more frequent suggestions

## Verbose Mode Behavior

- `meetverbose` mirrors raw final transcript lines through OpenClaw hook injection
- Mirrors are routed via `/hooks/agent` with `channel=last` so they stay in the currently active chat program/channel
- Optional Telegram mirror can be enabled with `DEBUG_MIRROR_TELEGRAM=true`

## Webhook Endpoint (HTTPS)

The bridge listens on HTTP. Recall.ai requires HTTPS for webhook delivery, so you need a reverse proxy or tunnel in front of the bridge.

See the [main README — Exposing the webhook endpoint](../../README.md#exposing-the-webhook-endpoint) for setup options (Caddy, Cloudflare Tunnel, Nginx, Tailscale Funnel).

For local development without a public URL, the bridge includes a [polling fallback](poller.js) that fetches transcripts directly from the Recall API.

## Health Check

```bash
curl -s http://127.0.0.1:3001/health
```
