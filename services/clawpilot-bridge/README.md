# Recall Bridge Service

Express service that receives Recall.ai webhook events and forwards transcript-driven copilot prompts into OpenClaw via `/hooks/wake`.

## Features

- Recall bot launch endpoint (`/launch`)
- Recall webhook receiver (`/webhook`)
- Copilot control endpoints (`/copilot/status`, `/mute`, `/unmute`, `/meetverbose/*`)
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
- `WEBHOOK_SECRET`
- `WEBHOOK_BASE_URL`
- `OPENCLAW_HOOK_URL`
- `OPENCLAW_HOOK_TOKEN`

## Health Check

```bash
curl -s http://127.0.0.1:3001/health
```
