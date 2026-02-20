# ClawPilot Pre-Launch Manual Test Plan

## Summary

Goal: validate first-time user installation, command reliability, channel routing correctness, and launch safety before public release.

Chosen defaults:

1. Scope: Balanced Core
2. Launch gate: Block P0/P1 only
3. Evidence: Structured Log

Success criteria:

1. Fresh-install flow is reproducible on a clean VPS and plugin loads correctly.
2. All `/clawpilot` commands behave correctly on Telegram, WhatsApp, and Discord.
3. Live meeting flow works end-to-end and responses stay in the originating chat.
4. No P0/P1 defects remain open.

## Interfaces Under Test

1. Chat command interface:
- `/clawpilot help`
- `/clawpilot status`
- `/clawpilot join <meeting_url> [--name "..."]`
- `/clawpilot pause`
- `/clawpilot resume`
- `/clawpilot transcript on|off`
- `/clawpilot mode [name]`
- `/clawpilot audience private|shared`
- `/clawpilot privacy`

2. Bridge HTTP interface:
- `GET /health`
- `GET /copilot/status`
- `POST /launch`
- `POST /webhook`
- `POST /mute`
- `POST /unmute`
- `POST /meetverbose/on`
- `POST /meetverbose/off`
- `GET /copilot/mode`
- `POST /copilot/mode`
- `GET /copilot/privacy`
- `POST /copilot/audience`
- `GET /meeting`
- `GET /meeting/state`
- `GET /meeting/stream`

3. Install/runtime interface:
- `openclaw plugins install ...`
- `openclaw daemon restart`
- Bridge restart command: `systemctl restart recall-webhook.service`

## Environment and Data

1. Environment:
- One production-like VPS.
- OpenClaw running remotely on VPS.
- Bridge service on VPS.
- Recall account configured.
- Telegram, WhatsApp, Discord connected to same OpenClaw instance.

2. Test accounts/chats:
- One DM and one group chat per channel where possible.
- Origin chat labels for logging: `TG_DM`, `WA_DM`, `DC_DM`.

3. Meeting URLs:
- Primary provider: Google Meet (one reusable valid room).
- One unsupported URL fixture.

## Execution Sequence

1. Preflight and clean-state setup.
2. Fresh installation and first-run checks.
3. Command matrix on each channel.
4. Live join/reaction/routing validation on each channel.
5. Failure, resilience, and security checks.
6. Launch-gate review and defect triage.

## Test Cases

### A. Preflight and Fresh Install

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| A-01 | Clean plugin state | Uninstall `clawpilot` if present; confirm absent via `openclaw plugins info clawpilot` | Plugin not loaded before install |
| A-02 | Fresh install | Install plugin artifact/package; restart daemon | Install succeeds; no load errors |
| A-03 | Plugin visibility | Run plugin info | `clawpilot` loaded; expected version shown |
| A-04 | Bridge required env | Start bridge with required env populated | Bridge starts cleanly |
| A-05 | Bridge health | `GET /health` and `GET /copilot/status` | `status=ok`; expected fields present |

### B. Command Behavior Matrix (Telegram, WhatsApp, Discord)

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| B-01 | Help default | Send `/clawpilot` | Help text returned |
| B-02 | Help explicit | Send `/clawpilot help` | Help text returned |
| B-03 | Status | Send `/clawpilot status` | Status response; no error |
| B-04 | Join usage guard | Send `/clawpilot join` | Usage guidance shown |
| B-05 | Join unsupported URL | Send `/clawpilot join https://example.com/x` | Rejected with usage/support hint |
| B-06 | Join valid URL | Send `/clawpilot join <valid_meet_url>` | Join summary with bot ID and meeting info |
| B-07 | Join with custom name | Send `/clawpilot join <valid_meet_url> --name "QA Bot"` | Summary reflects bot name |
| B-08 | Pause | Send `/clawpilot pause` | Paused confirmation |
| B-09 | Resume | Send `/clawpilot resume` | Resumed confirmation |
| B-10 | Transcript on | Send `/clawpilot transcript on` | Transcript mirror ON confirmation |
| B-11 | Transcript off | Send `/clawpilot transcript off` | Transcript mirror OFF confirmation |
| B-12 | Unknown subcommand | Send `/clawpilot nope` | Unknown command + help |
| B-13 | Mode status | Send `/clawpilot mode` | Current mode + available modes shown |
| B-14 | Mode set | Send `/clawpilot mode brainstorm` | Mode updated confirmation |
| B-15 | Audience set shared | Send `/clawpilot audience shared` | Shared audience confirmation |
| B-16 | Privacy status | Send `/clawpilot privacy` | Owner binding + audience policy shown |
| B-17 | Reveal command retired | Send `/clawpilot reveal context` | Unknown command + help shown |
| B-18 | Bridge unavailable handling | Stop bridge temporarily; send `/clawpilot status` | User-friendly command failed message |

### C. Cross-Chat Routing Correctness

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| C-01 | Origin chat pinning | Launch from `TG_DM`, `WA_DM`, `DC_DM` separately | Reactions return to launch-origin chat |
| C-02 | Group vs DM | Launch in group, then in DM | No drift between group and DM targets |
| C-03 | Multi-channel isolation | Active runs in two channels at once | Each run routes to its own source chat |

### D. Live Meeting Flow

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| D-01 | Admit bot flow | Launch bot; admit in meeting | Bot joins and receives transcript events |
| D-02 | Reaction generation | Speak test prompts in meeting | Copilot suggestion appears in origin chat |
| D-03 | Transcript mirror on | Enable transcript mirroring and speak | Raw transcript lines are mirrored |
| D-04 | Transcript mirror off | Disable mirroring and speak | Raw mirror stops; guidance still works |
| D-05 | Meeting end cleanup | End meeting | Session closes cleanly; no stuck activity |

### E. Failure and Resilience

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| E-01 | Duplicate join same meeting | Trigger second join to same meeting | Existing bot replaced or deterministic handling shown |
| E-02 | Webhook token mismatch | Send webhook with bad token | Unauthorized/rejected behavior confirmed |
| E-03 | Bridge restart recovery | Restart bridge during test run | Service returns healthy; new commands work |
| E-04 | OpenClaw restart recovery | Restart OpenClaw daemon | Plugin loads and commands recover |
| E-05 | Discord direct fallback | Disable/misconfigure Discord direct token, keep hooks valid | Delivery falls back via hooks path |

### F. Security and Launch Safety

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| F-01 | Secret leakage check | Inspect command responses for sensitive URLs/tokens | No secret/token leakage |
| F-02 | Log hygiene spot check | Review bridge logs around errors | No raw secret exposure in logs |
| F-03 | Repo secret scan | Run `npm run security:scan` | No obvious secrets found |
| F-04 | Plugin pack sanity | Run plugin pack dry-run check | Packaging succeeds |
| F-05 | Bridge auth required on launch | Call `POST /launch` without/with wrong bearer token | Unauthorized (401) until valid token is supplied |

### G. Upgrade and Uninstall Lifecycle

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| G-01 | Upgrade install | Install newer build over existing | Updated version active |
| G-02 | Uninstall | Uninstall plugin and restart | Commands no longer available |
| G-03 | Reinstall after uninstall | Reinstall from scratch | Normal behavior restored |

## Additional Before-Launch Coverage

1. 30-60 minute soak run during a realistic meeting.
2. Restart tolerance check for bridge and OpenClaw under active usage.
3. Operational runbook validation for non-dev operator recovery.
4. Rollback drill to previous known-good plugin in under 10 minutes.
5. Latency benchmark capture:
- Command response latency target: < 3s p95
- Meeting reaction latency target: < 10s p95

## Evidence Capture Format

Record one row per case in `evidence-log.csv` with:

- `run_id`
- `date_time_utc`
- `channel`
- `chat_type`
- `case_id`
- `result`
- `defect_id`
- `notes`
- `artifact_ref`

## Severity and Launch Gate

1. Severity:
- P0: security breach, data leak, total outage, wrong-chat delivery of sensitive output.
- P1: core command/join flow broken on any launch channel.
- P2: non-critical issue with workaround.

2. Gate:
- Launch blocked by any open P0 or P1.
- P2 may ship only with documented workaround, owner, and target fix date.

## Exit Criteria

1. 100% execution of cases A-G across Telegram, WhatsApp, Discord for Balanced Core.
2. Zero open P0/P1.
3. Soak run completed without unresolved critical incident.
4. Installation and rollback verified.
5. Final signoff summary produced from structured logs.

## Assumptions and Defaults

1. Single VPS environment represents launch architecture.
2. One tester executes; second reviewer needed only for signoff.
3. Google Meet is primary provider for this cycle.
4. VPS branch may have no upstream tracking; runs may use `SKIP_PULL=true`.
5. Private deployment flow remains outside repo:
- `/Users/danpeguine/Projects/clawpilot-vps.sh`
- `/Users/danpeguine/Projects/.clawpilot-vps.env`
