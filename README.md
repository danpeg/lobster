# ClawPilot

Let your OpenClaw join meetings and actively participate: do research, come up with ideas, create assets as you go.

ClawPilot connects Recall.ai live transcripts to OpenClaw so your copilot can react in real time during meetings.

## Prerequisites

1. OpenClaw installed and working
2. OpenClaw model/channel auth already configured
3. Node.js 18+ on the OpenClaw host
4. Recall.ai account and API key
5. Tailscale installed on the OpenClaw host

## Recommended Install Path

```bash
./scripts/chat-install-lobster.sh
```

This script enforces strict installer narration phases:

1. source check
2. install plugin
3. restart gateway
4. verify plugin loaded
5. run `/clawpilot install`
6. final pass/fail

Output format is always:

`Step N/M: <action> -> <OK|FAILED>`

Greedy internal recovery runs before any visible `FAILED`. On first visible failure, the script stops and prints remediation.

AI installer protocol reference:

1. `/Users/danpeguine/Projects/lobster/INSTALL_AGENT_PROTOCOL.md`

Exact prompt snippet:

```text
Install Lobster and narrate progress in chat using exactly:
Step N/M: <action> -> <status>

Required phases: source check, install plugin, restart gateway, verify loaded, run /clawpilot install, final pass/fail.
On first failure: stop, mark FAILED, provide remediation, and do not continue.
Never print secret values.
```

## Chat-Only Onboarding (WhatsApp/Telegram/Discord)

After install, run in chat:

```text
/clawpilot install
```

`/clawpilot setup` is kept as an alias of `/clawpilot install`.

The install finalizer is deterministic and greedy:

1. bounded retries for Tailscale auth, Funnel discovery/enablement, and health checks
2. bridge token auto-generation/sync when missing
3. auth preflight validation (`401` unauth + `200` auth)
4. explicit remediation when `RECALL_API_BASE` cannot be resolved

No terminal is required for the normal user path.

Installer limitation:

1. First-install narration cannot be hard-enforced before plugin load.
2. Post-install transparency is guaranteed once plugin is loaded via `/clawpilot install`.

## Configure Runtime (Required)

Bridge runtime is bundled in the plugin package and managed by plugin service lifecycle.

Bootstrap your env file (region-aware; no hardcoded Recall region default):

```bash
./scripts/bootstrap-recall.sh
```

Required environment variables:

1. `RECALL_API_KEY`
2. `RECALL_API_BASE` (match your Recall workspace region)
3. `WEBHOOK_SECRET`
4. `WEBHOOK_BASE_URL` (required `https://*.ts.net` for supported install/reinstall/update)
5. `BRIDGE_API_TOKEN` (optional in env; plugin auto-generates/syncs if missing)

Bootstrap and `/clawpilot install` both enforce Funnel alignment and bridge health.

OpenClaw integration values are loaded from `openclaw.json`:

6. `hooks.*` (for `/hooks/wake` + token)
7. `channels.discord.botToken` (for direct Discord delivery)
8. If bridge runs as a different OS user, set `OPENCLAW_CONFIG_PATH` to the correct `openclaw.json`

Optional bridge behavior:

9. `DISCORD_DIRECT_DELIVERY` (default: `true`)

Routing is channel-agnostic by default (via OpenClaw hooks). Discord direct delivery is an optional adapter with fallback to OpenClaw hooks.

Quick preflight checks:

```bash
./scripts/require-tailscale-funnel.sh
./scripts/chat-install-lobster.sh
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

1. `packages/clawpilot-plugin`: npm-installable OpenClaw plugin (`/clawpilot` command + managed bridge service)
2. `packages/clawpilot-plugin/bridge-runtime`: bundled bridge runtime shipped inside plugin artifact
3. `services/clawpilot-bridge`: source bridge implementation and ops docs
4. `services/clawpilot-bridge/prompts/lobster.md`: editable meeting copilot prompt pack

## Security Notes

1. Installer/finalizer output redacts token/API secret values.
2. Plugin-managed runtime can read required process env (`RECALL_API_KEY`, `RECALL_API_BASE`, `WEBHOOK_SECRET`) without printing values.
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
6. Installer replied "done" but commands fail:
   run `/clawpilot install` in chat; it performs step-by-step recovery and remediation.
