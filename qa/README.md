# ClawPilot QA

This folder contains the pre-launch manual QA workflow for ClawPilot.

## Quick Start

1. Initialize a new QA run workspace:

```bash
bash ./scripts/qa-init-run.sh
```

2. Optional: run pre-launch local checks:

```bash
bash ./scripts/qa-quick-checks.sh
```

Optional VPS auth preflight (checks bridge auth alignment and writes `bridge-auth-check.log`):

```bash
RUN_VPS_AUTH_CHECK=true bash ./scripts/qa-quick-checks.sh
```

3. Execute test cases from:

`qa/prelaunch-manual-test-plan.md`

4. Record outcomes in the generated run folder:

`qa/runs/<run_id>/`

## Run Artifacts

Each run folder contains:

1. `evidence-log.csv` - structured per-case execution records.
2. `defect-log.csv` - defect tracking with severity and owner.
3. `signoff.md` - launch-gate and final approval summary.
4. `run-notes.md` - free-form notes and environment details.
5. `quick-checks.log` - optional output from script-level checks.
