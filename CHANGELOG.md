# Changelog

## [0.1.2] - 2026-02-17

- Removed static browser launcher page from bridge service
- Added default Recall bot naming based on agent name (`<agent> Note Taker`)
- Added optional bot name overrides (`RECALL_BOT_NAME`, `RECALL_BOT_NAME_SUFFIX`)
- Added `/clawpilot launch <meeting_url> [--name "..."]` chat command

## [0.1.1] - 2026-02-17

- Removed plugin environment variable fallback reads for bridge URL/token
- Added bridge host allowlist (localhost, private IPs, and `*.ts.net` by default)
- Added explicit `allowRemoteBridge` opt-in for non-private endpoints

## [0.1.0] - 2026-02-17

- Initial public scaffolding for ClawPilot
- Added npm plugin package (`clawpilot`)
- Added Recall bridge service with env-based config
- Added bootstrap and security scan scripts
- Added branch/release documentation
