# Lobster Agent Guide

This file is the deterministic machine contract for setup, verification, and recovery.

```yaml
project:
  name: Lobster
  purpose: "Meeting AI that participates in live conversations through OpenClaw."
entrypoints:
  chat_commands:
    - /lobster install
    - /lobster connect <bridge_url> --token <BRIDGE_API_TOKEN>
    - /lobster status
    - /lobster join <meeting_url> [--name "Bot Name"]
    - /lobster pause
    - /lobster resume
    - /lobster mode [name]
    - /lobster audience <private|shared>
    - /lobster transcript <on|off>
  service_paths:
    - services/clawpilot-bridge
    - services/clawpilot-bridge/prompts/lobster.md
    - packages/clawpilot-plugin
required_env:
  bridge:
    - RECALL_API_KEY
    - RECALL_API_BASE
    - WEBHOOK_SECRET
    - WEBHOOK_BASE_URL
    - BRIDGE_API_TOKEN
  constraints:
    - "WEBHOOK_BASE_URL MUST be https://*.ts.net"
    - "public /health MUST match local /health bridge identity"
install:
  steps:
    - "Step 1: Install plugin: openclaw plugins install @lobster/lobster"
    - "Step 2: Restart gateway: openclaw daemon restart"
    - "Step 3: Confirm plugin: openclaw plugins info lobster"
    - "Step 4: Run onboarding in chat: /lobster install"
    - "Step 5: Bootstrap bridge env: ./scripts/bootstrap-recall.sh"
    - "Step 6: Start bridge from services/clawpilot-bridge"
verify:
  health:
    - "curl -s http://127.0.0.1:3001/health"
    - "curl -s https://<node>.ts.net/health"
  command_checks:
    - /lobster status
    - /lobster join <meeting_url>
    - /lobster mode
  expected_outcomes:
    - "health endpoints return status ok"
    - "status command returns bridge + mode state"
    - "join command returns launch confirmation"
security:
  must:
    - "Never print token values in logs or chat"
    - "Enforce bearer auth on protected bridge routes"
    - "Keep audience default private unless user switches to shared"
    - "Run funnel preflight before launch flows"
  checks:
    - ./scripts/require-tailscale-funnel.sh
    - npm run security:scan
recovery:
  install_drift:
    - /lobster install
    - "re-run bootstrap-recall and restart bridge"
  auth_failures:
    - "Set plugin bridge token to BRIDGE_API_TOKEN"
    - "Restart openclaw daemon"
  bridge_down:
    - "Validate bridgeBaseUrl"
    - "Validate local/public /health"
    - "Restart bridge service"
doc_precedence:
  human_narrative: README.md
  installer_protocol: INSTALL_AGENT_PROTOCOL.md
  service_reference: services/clawpilot-bridge/README.md
```

## Command Execution Contract

1. Prefer chat-first onboarding (`/lobster install`) before manual remediation.
2. If onboarding fails, stop on first failure, report failure state, and provide remediation.
3. Keep outputs concise and actionable: status, failure reason, next command.

## Safety Rules

1. Do not expose secrets in generated output.
2. Do not skip Funnel and auth checks for install/reinstall/update.
3. Do not continue after a failed mandatory preflight.

## Human Coordination

For end-user explanations, refer to:

- `/Users/danpeguine/Projects/lobster/README.md`
- `/Users/danpeguine/Projects/lobster/INSTALL_AGENT_PROTOCOL.md`
- `/Users/danpeguine/Projects/lobster/services/clawpilot-bridge/README.md`
