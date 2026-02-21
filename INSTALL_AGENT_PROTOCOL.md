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
