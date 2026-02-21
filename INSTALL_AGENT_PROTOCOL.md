# Lobster Install Agent Protocol

Use this protocol when an AI installer installs/reinstalls/updates Lobster from chat.

## Required Chat Output Format

For each step, output one line:

`Step N/M: <action> -> <status>`

Status values:

- `OK`
- `FAILED`

Do not skip steps. Do not merge multiple steps into one line.

## Required Step Phases

1. Source check (target repo/branch/package identified)
2. Install plugin
3. Restart OpenClaw gateway/daemon
4. Verify plugin is loaded
5. Run `/clawpilot install` in chat
6. Final pass/fail summary

## Failure Policy (Mandatory)

1. Stop immediately on first failed step.
2. Output `FAILED` for that step.
3. Provide exact remediation commands or next action in chat.
4. Do not continue remaining steps after a failure.

## Greedy Bridge Recovery Policy

Use this policy inside each step before a visible `FAILED` status is emitted.

### Retry Budgets and Timeouts

1. Installer step retries:
- Maximum 3 attempts per step.
- Default delay between attempts: 2 seconds.
- Per-attempt command timeout: 30 seconds unless a longer timeout is explicitly required.

2. Bridge readiness retries:
- Health readiness window: up to 30 seconds total.
- Probe interval: every 1 second.

3. Tailscale and Funnel retries:
- Auth discovery: up to 3 attempts.
- Funnel discovery/enablement: up to 3 attempts.

### Ordered Remediation Ladder

Apply in order; stop when one remediation succeeds.

1. Bridge unreachable:
- Re-check plugin config and local bridge URL.
- Restart managed bridge service.
- Re-probe local `/health`.
- Re-probe public Funnel `/health`.

2. Auth mismatch (`401`/token drift):
- Load plugin `bridgeToken` state.
- Auto-generate bridge token if missing.
- Sync plugin `bridgeToken` to bridge token.
- Re-run unauth/auth probe pair.

3. Tailscale/funnel issues:
- Resolve Tailscale binary path (PATH, macOS app bundle, Homebrew paths).
- Re-check Tailscale auth state.
- Re-enable Funnel for bridge port.
- Re-probe Funnel URL and health.

4. Recall region/config issues:
- Discover `RECALL_API_BASE` from known env/config sources.
- Probe candidate region endpoints when needed.
- Fail with explicit remediation if no region can be resolved.

### When A Step Is Finally `FAILED`

A step is finally `FAILED` only when:

1. all retries are exhausted,
2. all remediation ladder actions for that failure class are exhausted,
3. and the success condition still cannot be met.

After that, stop immediately and print remediation. Do not continue to later steps.

### Secret Redaction Requirements

1. Never print raw token values, API keys, webhook secrets, or env file contents.
2. Redact sensitive values in logs and chat summaries (for example: `***redacted***`).
3. If a remediation command requires a secret placeholder, use symbolic placeholders only (`<BRIDGE_API_TOKEN>`, `<RECALL_API_KEY>`).

## Secret Handling (Mandatory)

1. Never print token values, webhook secrets, API keys, or env file contents.
2. If a secret is required, ask user to provide/store it securely and continue without echoing it.

## Installer Prompt Snippet

Use this exact instruction when asking an AI installer to run Lobster install:

```text
Install Lobster and narrate progress in chat using exactly:
Step N/M: <action> -> <status>

Required phases: source check, install plugin, restart gateway, verify loaded, run /clawpilot install, final pass/fail.
On first failure: stop, mark FAILED, provide remediation, and do not continue.
Never print secret values.
```
