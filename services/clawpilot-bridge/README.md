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

## OpenClaw Configuration Source

- Hook URL/token are read from `openclaw.json` (`hooks.path`, `hooks.token`, `gateway.port`)
- Discord bot token is read from `openclaw.json` (`channels.discord.botToken`)
- Telegram bot token is read from `openclaw.json` (`channels.telegram.botToken`)
- Set `OPENCLAW_CONFIG_PATH` if bridge should read a non-default `openclaw.json`

## Optional Bot Naming

- `OPENCLAW_AGENT_NAME` -> default bot name becomes `<OPENCLAW_AGENT_NAME> Note Taker`
- `RECALL_BOT_NAME` -> explicit override
- `RECALL_BOT_NAME_SUFFIX` -> defaults to `Note Taker`

## Optional Discord Delivery

- Routing is channel-agnostic by default: all channels deliver via OpenClaw hooks
- `DISCORD_DIRECT_DELIVERY` controls direct-first mode (default: `true`)
- Discord direct delivery is an adapter; if it fails, bridge falls back to OpenClaw hook delivery

## Voice-in-Meeting MVP

- Explicit trigger only (default wake names: `fugu`, `clawpilot`, `copilot`)
- Uses ElevenLabs TTS, then Recall `output_media` to speak in meeting
- Optional approval gate in Meet chat: bot posts a hand-raise message and waits for `yes` before speaking
- Configure in `openclaw.json`:
  - `integrations.elevenlabs.apiKey`
  - `plugins.entries.clawpilot.config.voice.enabled`
  - `plugins.entries.clawpilot.config.voice.voiceId`
  - Optional: `wakeNames`, `modelId`, `cooldownMs`, `minSilenceMs`, `maxChars`, `mirrorToChat`
- Runtime env overrides:
  - `VOICE_REQUIRE_WAKE=false`
  - `VOICE_COOLDOWN_MS=3000`
  - `VOICE_MIN_SILENCE_MS=350`
  - `VOICE_TRIGGER_ON_PARTIAL=true`
  - `VOICE_APPROVAL_REQUIRED=true`
  - `VOICE_APPROVAL_TIMEOUT_MS=20000`
- Chat controls:
  - `/clawpilot voice on`
  - `/clawpilot voice off`
  - `/clawpilot voice status`

## Reaction Style Defaults

- Reactions are final-transcript driven by default (`REACT_ON_PARTIAL=false`)
- Output is a single natural coaching line (no forced numbered format)
- Default proactivity is `high` for faster, more frequent suggestions

## Verbose Mode Behavior

- `meetverbose` mirrors raw final transcript lines through OpenClaw hook injection
- Mirrors are routed via `/hooks/agent` with `channel=last` so they stay in the currently active chat program/channel
- Optional Telegram mirror can be enabled with `DEBUG_MIRROR_TELEGRAM=true`

## Health Check

```bash
curl -s http://127.0.0.1:3001/health
```
