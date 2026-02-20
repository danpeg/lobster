# Sensitive Data Audit Runbook

## Scope
- Repository: `lobster`
- Coverage: local heads, `origin/*`, and tags
- Deliverables: `/Users/danpeguine/Projects/.clawpilot-audit/runs/<run_id>/`

## Commands
- Baseline full scan (tree + history + manual + existing secret script):
  - `npm run audit:sensitive:baseline`
- Weekly scan (tree + manual + existing secret script):
  - `npm run audit:sensitive:weekly`
- Monthly scan (full baseline depth):
  - `npm run audit:sensitive:monthly`
- PR/release gate scan:
  - `npm run audit:sensitive:pr-gate`

## Optional env overrides
- `AUDIT_ROOT=/Users/danpeguine/Projects/.clawpilot-audit`
- `RUN_ID=run-YYYYMMDDTHHMMSSZ`
- `TARGET_REF=origin/main` (for `pr-gate`)
- `ENFORCE_GATE=true` (block on P0/P1 in any mode)

## Required outputs per run
- `refs-in-scope.txt`
- `raw-findings.txt`
- `findings.csv`
- `triage.md`
- `remediation-plan.md`
- `rerun-verification.txt`

## Severity and gate
- `P0`: active secrets/credentials or sensitive personal data leakage.
- `P1`: private business/confidential info, private URLs/apps exposing topology or accounts.
- `P2`: non-critical hygiene.
- Release/merge gate: block on open `P0` or `P1`.
