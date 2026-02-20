# Recall Bridge Service

Express service that receives Recall.ai webhook events and forwards transcript-driven copilot prompts into OpenClaw via `/hooks/wake`.

## Features

- Recall bot launch endpoint (`/launch`)
- Recall webhook receiver (`/webhook`)
- Copilot control endpoints (`/copilot/status`, `/copilot/mode`, `/copilot/privacy`, `/copilot/audience`, `/copilot/reveal`, `/mute`, `/unmute`, `/meetverbose/*`)
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
- `WEBHOOK_BASE_URL` (required `https://*.ts.net` for supported install/reinstall/update)

## Tailscale Funnel Enforcement

- Install/reinstall/update is hard-blocked unless Funnel is correctly aligned to bridge.
- End-user onboarding can run from chat via `/clawpilot setup` (no terminal required for normal path).
- Required checks:
  - local `GET /health` returns `200`
  - public `${WEBHOOK_BASE_URL}/health` returns `200` with expected bridge shape
  - URL is `https://*.ts.net`

Run preflight manually:

```bash
../../scripts/require-tailscale-funnel.sh
```

Reinstall/update recovery:

1. Rerun bootstrap:
   `../../scripts/bootstrap-recall.sh`
2. Re-run QA preflight:
   `RUN_VPS_AUTH_CHECK=true npm run qa:quick-checks`
3. Re-sync plugin token if needed:
   `openclaw config set plugins.entries.clawpilot.config.bridgeToken "<BRIDGE_API_TOKEN>"`
   `openclaw daemon restart`

## Bridge API Auth (Recommended)

- Set `BRIDGE_API_TOKEN` to enforce bearer auth on bridge control/data routes.
- Send `Authorization: Bearer <BRIDGE_API_TOKEN>` from trusted callers (for example the ClawPilot plugin using `bridgeToken`).
- `/health` and `/webhook` remain unauthenticated for liveness/Recall delivery.

Protected routes when `BRIDGE_API_TOKEN` is set:

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

Migration note:

- If `/clawpilot` commands start returning `401`, set plugin config `bridgeToken` to match `BRIDGE_API_TOKEN`.
- If `/clawpilot` commands return network errors, verify plugin `bridgeBaseUrl` and Funnel `/health` connectivity.

## launch-bot.sh behavior

- `launch-bot.sh` now requires a valid Funnel URL by default.
- Legacy ngrok fallback is disabled unless `ALLOW_NGROK_FALLBACK=true`.
- Even with fallback enabled, health preflight still runs before bot launch.

## OpenClaw Configuration Source

- Hook URL/token are read from `openclaw.json` (`hooks.path`, `hooks.token`, `gateway.port`)
- Discord bot token is read from `openclaw.json` (`channels.discord.botToken`)
- Telegram bot token is read from `openclaw.json` (`channels.telegram.botToken`)
- Set `OPENCLAW_CONFIG_PATH` if bridge should read a non-default `openclaw.json`

## Optional Bot Naming

- `OPENCLAW_AGENT_NAME` -> default bot name becomes `<OPENCLAW_AGENT_NAME>`
- `RECALL_BOT_NAME` -> explicit override

## Optional Discord Delivery

- Routing is channel-agnostic by default: all channels deliver via OpenClaw hooks
- `DISCORD_DIRECT_DELIVERY` controls direct-first mode (default: `true`)
- Discord direct delivery is an adapter; if it fails, bridge falls back to OpenClaw hook delivery

## Routed Copilot Delivery (All Channels)

- `OPENCLAW_COPILOT_CLI_ROUTED=true` (default) enables a routed copilot path that:
  - generates the suggestion via `openclaw agent --json`
  - delivers the final text via `openclaw message send --json`
- This avoids hook-path `NO_REPLY` suppression on routed channels.
- Tune with:
  - `OPENCLAW_CLI_BIN` (default: `openclaw`)
  - `OPENCLAW_AGENT_CLI_TIMEOUT_MS` (default: `45000`)
  - `OPENCLAW_MESSAGE_CLI_TIMEOUT_MS` (default: `20000`)
- Route/session mappings are persisted across bridge restarts so active meetings keep chat routing:
  - `BRIDGE_STATE_FILE` (default: `.bridge-state.json` in the bridge directory)

## Reaction Style Defaults

- Reactions are final-transcript driven by default (`REACT_ON_PARTIAL=false`)
- Output is a single natural coaching line (no forced numbered format)
- Default proactivity is `high` for faster, more frequent suggestions

## Prompt Personalization

- The meeting copilot prompt now lives in:
  - `services/clawpilot-bridge/prompts/lobster.md`
- You can edit this markdown file to customize behavior, mode overlays, and privacy phrasing.
- Prompt changes are auto-reloaded (no bridge restart required).
- Override prompt file path with:
  - `LOBSTER_PROMPT_PATH=/absolute/path/to/prompt.md`

## Verbose Mode Behavior

- `meetverbose` mirrors raw final transcript lines through OpenClaw hook injection
- Mirrors are routed via `/hooks/agent` with `channel=last` so they stay in the currently active chat program/channel
- Optional Telegram mirror can be enabled with `DEBUG_MIRROR_TELEGRAM=true`

## Health Check

```bash
curl -s http://127.0.0.1:3001/health
```
