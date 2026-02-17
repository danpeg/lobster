# ClawPilot

Let your OpenClaw join meetings and actively participate: do research, come up with ideas, create assets as you go.

ClawPilot connects Recall.ai live transcripts to OpenClaw so your copilot can react in real time during meetings.

## Prerequisites

1. OpenClaw installed and working
2. OpenClaw model/channel auth already configured
3. Node.js 18+ on the bridge host
4. Recall.ai account and API key
5. Public HTTPS URL for Recall webhooks

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

Required environment variables:

1. `RECALL_API_KEY`
2. `RECALL_API_BASE` (match your Recall workspace region)
3. `WEBHOOK_SECRET`
4. `WEBHOOK_BASE_URL`
5. `OPENCLAW_HOOK_URL`
6. `OPENCLAW_HOOK_TOKEN`

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
5. Confirm transcripts trigger copilot responses.

## Components

1. `packages/clawpilot-plugin`: npm-installable OpenClaw plugin (`/clawpilot` command)
2. `services/clawpilot-bridge`: Recall webhook receiver and OpenClaw hook bridge

## Security Notes

1. The plugin does not read environment variables at runtime.
2. The plugin only calls your configured bridge endpoint for explicit `/clawpilot` commands.
3. Non-private bridge hosts are blocked by default unless `allowRemoteBridge` is explicitly enabled.

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
   confirm `WEBHOOK_BASE_URL` is public HTTPS and reachable from Recall.ai
