# Lobster Implementation Plan (Archived)

This file is retained as historical planning context from an earlier development phase.

Current source of truth for setup/runtime behavior:

1. `/Users/danpeguine/Projects/lobster/README.md`
2. `/Users/danpeguine/Projects/lobster/services/clawpilot-bridge/README.md`
3. `/Users/danpeguine/Projects/lobster/CHANGELOG.md`

Current architecture baseline (v1):

- Cloudflared quick tunnel ingress (`*.trycloudflare.com`)
- Local bridge control path (`127.0.0.1`)
- One-click setup via `npx clawpilot setup`
- Legacy config fail-fast with `--fresh` remediation
