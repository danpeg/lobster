#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/qa/templates"
RUNS_DIR="$ROOT_DIR/qa/runs"
RUN_ID="${1:-run-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$RUNS_DIR/$RUN_ID"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Missing templates directory: $TEMPLATE_DIR"
  exit 1
fi

if [[ -e "$RUN_DIR" ]]; then
  echo "Run directory already exists: $RUN_DIR"
  exit 1
fi

mkdir -p "$RUN_DIR"

# Create run-specific markdown artifacts from templates.
sed "s/__RUN_ID__/$RUN_ID/g" "$TEMPLATE_DIR/signoff-template.md" > "$RUN_DIR/signoff.md"
sed "s/__RUN_ID__/$RUN_ID/g" "$TEMPLATE_DIR/run-notes-template.md" > "$RUN_DIR/run-notes.md"

# Create defect log from template (header + example row removed).
head -n 1 "$TEMPLATE_DIR/defect-log-template.csv" > "$RUN_DIR/defect-log.csv"

EVIDENCE_FILE="$RUN_DIR/evidence-log.csv"

append_row() {
  local channel="$1"
  local chat_type="$2"
  local case_id="$3"
  printf '%s,,%s,%s,%s,NOT_RUN,,,%s\n' "$RUN_ID" "$channel" "$chat_type" "$case_id" "" >> "$EVIDENCE_FILE"
}

# Header
printf 'run_id,date_time_utc,channel,chat_type,case_id,result,defect_id,notes,artifact_ref\n' > "$EVIDENCE_FILE"

# Global/system cases
for case_id in A-01 A-02 A-03 A-04 A-05 E-01 E-02 E-03 E-04 F-01 F-02 F-03 F-04 F-05 G-01 G-02 G-03; do
  append_row "system" "n/a" "$case_id"
done

# Per-channel command matrix and live/routing
for channel in telegram whatsapp discord; do
  for case_id in B-01 B-02 B-03 B-04 B-05 B-06 B-07 B-08 B-09 B-10 B-11 B-12 B-13 C-01 C-03 D-01 D-02 D-03 D-04 D-05; do
    append_row "$channel" "dm" "$case_id"
  done

  # Group/DM drift check gets two rows per channel
  append_row "$channel" "group" "C-02"
  append_row "$channel" "dm" "C-02"
done

# Discord-specific direct-delivery fallback case
append_row "discord" "dm" "E-05"

cat > "$RUN_DIR/README.md" <<RUNINFO
# QA Run: $RUN_ID

Artifacts:

1. evidence-log.csv
2. defect-log.csv
3. signoff.md
4. run-notes.md
5. quick-checks.log (optional; created by qa-quick-checks.sh)

Next steps:

1. Execute cases from qa/prelaunch-manual-test-plan.md.
2. Update evidence-log.csv per execution.
3. Log defects in defect-log.csv with severity.
4. Complete signoff.md after gate review.
RUNINFO

echo "Initialized QA run: $RUN_ID"
echo "Run directory: $RUN_DIR"
