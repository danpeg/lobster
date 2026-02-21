# Changelog

## [0.3.0] - 2026-02-21

- Hard cutover to Cloudflared quick tunnels for Recall webhook ingress (no Tailscale/ngrok flow)
- Added in-bridge quick tunnel manager with restart/backoff and tunnel state in `/health`
- Added duplicate webhook suppression by `event_id` with bounded in-memory idempotency cache
- Added startup legacy-config guard with explicit remediation:
  - `Old config detected. Run \`npx clawpilot setup --fresh\` to reconfigure.`
- Added new one-click setup CLI package (`clawpilot`) with:
  - cloudflared install (`brew`/`apt`/user-local fallback)
  - plugin install + daemon restart + verify-loaded checks
  - strict step output and fail-fast remediation
- Updated plugin setup/connect UX to local bridge only (`127.0.0.1`) and quick-tunnel health checks

## [0.2.2] - 2026-02-17

- Changed `/clawpilot join` response to a concise summary instead of full raw Recall JSON payload
- Prevents leaking verbose launch internals (including webhook query tokens) into chat transcripts

## [0.2.1] - 2026-02-17

- Pinned meeting output routing to the chat where `/clawpilot join` was launched
- Plugin now sends launch origin routing metadata (`channel` + target id) to bridge
- Bridge now stores per-bot routing target and uses it for copilot reactions and transcript mirror messages
- Prevents group-launched meetings from drifting into DM replies

## [0.2.0] - 2026-02-17

- Consolidated plugin command UX to strict `/clawpilot <command>` verbs
- Added `/clawpilot help` as the default command
- Replaced command names:
  - `launch` -> `join`
  - `mute` -> `pause`
  - `unmute` -> `resume`
  - `verbose-on|verbose-off` -> `transcript on|off`
- Removed legacy command aliases in plugin routing

## [0.1.6] - 2026-02-17

- Changed verbose transcript mirroring to use OpenClaw `/hooks/agent` with `channel=last`
- Improves cross-channel behavior so transcript echoes stay in the active chat app (e.g., WhatsApp)

## [0.1.5] - 2026-02-17

- Added `RECALL_API_BASE` env support for region-specific Recall workspaces
- Removed hardcoded `eu-central-1` Recall endpoints in bridge and launch scripts
- Made `meetverbose` mirror behavior channel-agnostic by default via OpenClaw hook injection

## [0.1.4] - 2026-02-17

- Changed `meetverbose` behavior to mirror raw transcript lines through OpenClaw hook injection
- Raw transcript mirrors now follow the active chat channel/program instead of Telegram-only behavior
- Added optional `DEBUG_MIRROR_TELEGRAM` for secondary Telegram mirroring
- Improved hook response parsing to handle non-JSON error responses safely

## [0.1.3] - 2026-02-17

- Improved default bot naming: plugin now sends inferred agent name on launch
- Bridge now accepts `agent_name` and uses `<agent> Note Taker` default when provided
- Added plugin config override for `agentName`
- Smoothed copilot message style to natural single-line coaching (no forced numbered format)
- Reduced default reaction aggressiveness and disabled partial-triggered reactions by default

## [0.1.2] - 2026-02-17

- Removed static browser launcher page from bridge service
- Added default Recall bot naming based on agent name (`<agent> Note Taker`)
- Added optional bot name overrides (`RECALL_BOT_NAME`, `RECALL_BOT_NAME_SUFFIX`)
- Added `/clawpilot launch <meeting_url> [--name "..."]` chat command

## [0.1.1] - 2026-02-17

- Removed plugin environment variable fallback reads for bridge URL/token
- Added bridge host allowlist (localhost/private hosts at the time)
- Added explicit `allowRemoteBridge` opt-in for non-private endpoints

## [0.1.0] - 2026-02-17

- Initial public scaffolding for ClawPilot
- Added npm plugin package (`clawpilot`)
- Added Recall bridge service with env-based config
- Added bootstrap and security scan scripts
- Added branch/release documentation
