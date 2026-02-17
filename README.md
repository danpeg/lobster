# ClawPilot

Real-time meeting transcript analysis with Recall.ai + OpenClaw.

## Branch Model

- `main`: stable release path
- `experimental`: active development, including Notion and Google Docs integrations

Both branches are public-safe only (no secrets in code).

## Install (Plugin)

```bash
openclaw plugins install @curious-endeavor/clawpilot
openclaw daemon restart
openclaw plugins info clawpilot
```

## Required Runtime Setup

OpenClaw auth/channel setup is assumed to be already configured.

Then configure Recall + bridge service:

```bash
./scripts/bootstrap-recall.sh
cd services/clawpilot-bridge
set -a; source ./.env; set +a
npm install
npm start
```

## Components

- `packages/clawpilot-plugin`: npm-installable OpenClaw plugin
- `services/clawpilot-bridge`: Recall webhook receiver and copilot bridge service

## Release

1. Develop on `experimental`
2. Merge curated changes to `main`
3. Run checks:
   - `npm run security:scan`
   - `npm run check:plugin-pack`
4. Publish plugin package from `packages/clawpilot-plugin`

See `RELEASING.md` for full steps.
