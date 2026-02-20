#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-baseline}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_ROOT="${AUDIT_ROOT:-/Users/danpeguine/Projects/.clawpilot-audit}"
RUN_ID="${RUN_ID:-run-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$AUDIT_ROOT/runs/$RUN_ID"
TARGET_REF="${TARGET_REF:-origin/main}"
ENFORCE_GATE="${ENFORCE_GATE:-false}"

REFS_FILE="$RUN_DIR/refs-in-scope.txt"
RAW_FILE="$RUN_DIR/raw-findings.txt"
CSV_FILE="$RUN_DIR/findings.csv"
TRIAGE_FILE="$RUN_DIR/triage.md"
REMEDIATION_FILE="$RUN_DIR/remediation-plan.md"
VERIFY_FILE="$RUN_DIR/rerun-verification.txt"
NORM_FILE="$RUN_DIR/.normalized.tsv"
DEDUP_FILE="$RUN_DIR/.normalized.dedup.tsv"
COMMITS_FILE="$RUN_DIR/.commits.txt"
CHANGED_FILE="$RUN_DIR/.changed-files.txt"

SECRET_RE='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{16,}|sk_endp_[A-Za-z0-9._-]{10,}|BEGIN[[:space:]]+PRIVATE[[:space:]]+KEY|Authorization:[[:space:]]*Bearer[[:space:]][A-Za-z0-9._-]{10,}|webhook\\?token=[A-Za-z0-9._-]{6,}|api[_-]?key[[:space:]]*[:=][[:space:]]*["'\''`]?[A-Za-z0-9._-]{10,})'
PRIVATE_URL_RE='(tail[a-z0-9.-]*\\.ts\\.net|ngrok\\.io|localhost:[0-9]{2,5}|127\\.0\\.0\\.1:[0-9]{2,5}|https?://[^[:space:]]*(internal|private|corp|vpn)[^[:space:]]*)'
BUSINESS_RE='([Pp]rice[[:space:]]+[Qq]uote|[Qq]uote[[:space:]]+[Aa]mount|[Pp]roposal[[:space:]]+[Aa]mount|invoice[[:space:]]*#[0-9A-Za-z-]+|[Ss]tatement[[:space:]]+[Oo]f[[:space:]]+[Ww]ork|\\bSOW\\b|\\$[0-9]{3,}|EUR[[:space:]]?[0-9]{3,}|USD[[:space:]]?[0-9]{3,}|rate[[:space:]]+card|payment[[:space:]]+terms)'
PERSONAL_RE='([Uu]ser:|[Aa]ssistant:|meeting[[:space:]]+transcript|transcript[[:space:]]+dump|@gmail\\.com|@yahoo\\.com|@hotmail\\.com|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4})'
APP_RE='(app_[A-Za-z0-9]{16,}|bot_[A-Za-z0-9]{16,}|consumer/[A-Za-z0-9_-]{12,}|google-service-account\\.json)'
COMBINED_RE="(${SECRET_RE}|${PRIVATE_URL_RE}|${BUSINESS_RE}|${PERSONAL_RE}|${APP_RE})"

log() {
  printf '[audit] %s\n' "$*"
}

csv_escape() {
  local s="${1:-}"
  s="${s//\"/\"\"}"
  printf '"%s"' "$s"
}

classify() {
  local path="$1"
  local snippet="$2"
  local text="$path $snippet"

  if printf '%s\n' "$text" | grep -Eq "$SECRET_RE"; then
    printf 'secret|P0'
    return
  fi
  if printf '%s\n' "$text" | grep -Eq "$PERSONAL_RE"; then
    printf 'personal_data|P1'
    return
  fi
  if printf '%s\n' "$text" | grep -Eq "$BUSINESS_RE"; then
    printf 'private_business|P1'
    return
  fi
  if printf '%s\n' "$text" | grep -Eq "$PRIVATE_URL_RE"; then
    if printf '%s\n' "$text" | grep -Eq '(localhost:[0-9]{2,5}|127\.0\.0\.1:[0-9]{2,5})'; then
      printf 'private_url|P2'
    else
      printf 'private_url|P1'
    fi
    return
  fi
  if printf '%s\n' "$text" | grep -Eq "$APP_RE"; then
    printf 'hardcoded_app|P1'
    return
  fi

  printf 'hardcoded_app|P2'
}

emit_match() {
  local source_type="$1"
  local ref="$2"
  local commit="$3"
  local file_path="$4"
  local line="$5"
  local snippet="$6"
  local notes="$7"

  snippet="$(printf '%s' "$snippet" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ //; s/ $//')"
  if [[ -z "$snippet" ]]; then
    return
  fi

  local cls
  cls="$(classify "$file_path" "$snippet")"
  local category="${cls%%|*}"
  local severity="${cls##*|}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$source_type" "$ref" "$commit" "$file_path" "$line" "$snippet" "$category" "$severity" "$notes" >> "$NORM_FILE"
}

append_raw_header() {
  local title="$1"
  {
    echo
    echo "===== $title ====="
  } >> "$RAW_FILE"
}

scan_git_object() {
  local source_type="$1"
  local object="$2"
  local ref_value="$3"
  local commit_value="$4"

  local out
  out="$(git -C "$REPO_DIR" grep -nI -E "$COMBINED_RE" "$object" -- . \
    ':(exclude)**/node_modules/**' \
    ':(exclude)**/.git/**' \
    ':(exclude)**/dist/**' \
    ':(exclude)**/build/**' \
    ':(exclude)**/package-lock.json' 2>/dev/null || true)"

  if [[ -z "$out" ]]; then
    return
  fi

  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    printf '%s|%s\n' "$source_type" "$match" >> "$RAW_FILE"

    local remainder file_path line snippet
    remainder="${match#*:}"
    file_path="${remainder%%:*}"
    remainder="${remainder#*:}"
    line="${remainder%%:*}"
    snippet="${remainder#*:}"

    emit_match "$source_type" "$ref_value" "$commit_value" "$file_path" "$line" "$snippet" "$source_type scan"
  done <<< "$out"
}

scan_manual_files() {
  append_raw_header "MANUAL TARGETED FILE REVIEW"
  local targets=(
    "services/clawpilot-bridge/README.md"
    "services/clawpilot-bridge/.env.example"
    "README.md"
    "SECURITY.md"
    "RELEASING.md"
    "CONTRIBUTING.md"
  )

  local f
  for f in "${targets[@]}"; do
    local abs="$REPO_DIR/$f"
    [[ -f "$abs" ]] || continue
    local out
    out="$(rg -n -e "$COMBINED_RE" "$abs" || true)"
    if [[ -z "$out" ]]; then
      continue
    fi
    while IFS= read -r line_match; do
      [[ -z "$line_match" ]] && continue
      echo "manual|$line_match" >> "$RAW_FILE"
      local path_part line_no snippet
      path_part="${line_match%%:*}"
      local rest="${line_match#*:}"
      line_no="${rest%%:*}"
      snippet="${rest#*:}"
      local rel_path="${path_part#"$REPO_DIR/"}"
      emit_match "manual-file" "HEAD" "HEAD" "$rel_path" "$line_no" "$snippet" "targeted manual file review"
    done <<< "$out"
  done

  append_raw_header "MANUAL NON-MAIN COMMIT MESSAGE REVIEW"
  local ref
  while IFS= read -r ref; do
    [[ "$ref" == "origin/main" ]] && continue
    [[ "$ref" != origin/* ]] && continue
    local logs
    logs="$(git -C "$REPO_DIR" log --format='%H|%s' "$ref" -- services/clawpilot-bridge scripts README.md SECURITY.md RELEASING.md CONTRIBUTING.md 2>/dev/null || true)"
    [[ -z "$logs" ]] && continue
    while IFS='|' read -r sha subject; do
      [[ -z "$sha" || -z "$subject" ]] && continue
      if printf '%s\n' "$subject" | grep -Eq "$BUSINESS_RE|$PERSONAL_RE|$PRIVATE_URL_RE|$APP_RE|$SECRET_RE"; then
        echo "manual-commit|$ref|$sha|$subject" >> "$RAW_FILE"
        emit_match "manual-commit" "$ref" "$sha" "(commit-message)" "0" "$subject" "targeted commit subject review"
      fi
    done <<< "$logs"
  done < "$REFS_FILE"
}

scan_existing_script_baseline() {
  append_raw_header "EXISTING SCRIPT BASELINE"
  local scan_script="$REPO_DIR/scripts/scan-secrets.sh"
  if [[ ! -x "$scan_script" ]]; then
    echo "scan-secrets.sh missing or not executable" >> "$RAW_FILE"
    return
  fi

  local out_file="$RUN_DIR/.scan-secrets-output.txt"
  (cd "$REPO_DIR" && bash "$scan_script") > "$out_file" 2>&1 || true
  cat "$out_file" >> "$RAW_FILE"

  local current_ref
  current_ref="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" != *:*:* ]]; then
      continue
    fi
    local path_part rest line_no snippet
    path_part="${line%%:*}"
    rest="${line#*:}"
    line_no="${rest%%:*}"
    snippet="${rest#*:}"
    emit_match "script-baseline" "$current_ref" "HEAD" "$path_part" "$line_no" "$snippet" "scan-secrets baseline"
  done < "$out_file"
}

generate_csv() {
  sort -u "$NORM_FILE" > "$DEDUP_FILE"

  {
    echo 'finding_id,date_time_utc,ref,commit,file_path,line,category,severity,status,evidence_snippet,owner,notes'

    local i=1
    while IFS=$'\t' read -r source_type ref commit file_path line snippet category severity notes; do
      [[ -z "$source_type" ]] && continue
      local finding_id
      printf -v finding_id 'F%04d' "$i"
      local ts
      ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

      printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$(csv_escape "$finding_id")" \
        "$(csv_escape "$ts")" \
        "$(csv_escape "$ref")" \
        "$(csv_escape "$commit")" \
        "$(csv_escape "$file_path")" \
        "$(csv_escape "$line")" \
        "$(csv_escape "$category")" \
        "$(csv_escape "$severity")" \
        "$(csv_escape "open")" \
        "$(csv_escape "$snippet")" \
        "$(csv_escape "unassigned")" \
        "$(csv_escape "$notes | $source_type")"

      i=$((i + 1))
    done < "$DEDUP_FILE"
  } > "$CSV_FILE"
}

write_triage() {
  local total p0 p1 p2
  total="$(wc -l < "$DEDUP_FILE" | tr -d ' ')"
  p0="$(awk -F'\t' '$8=="P0" {c++} END {print c+0}' "$DEDUP_FILE")"
  p1="$(awk -F'\t' '$8=="P1" {c++} END {print c+0}' "$DEDUP_FILE")"
  p2="$(awk -F'\t' '$8=="P2" {c++} END {print c+0}' "$DEDUP_FILE")"

  {
    echo "# Sensitive Data Triage"
    echo
    echo "- run_id: $RUN_ID"
    echo "- mode: $MODE"
    echo "- repo: $REPO_DIR"
    echo "- generated_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- total_findings: $total"
    echo "- p0: $p0"
    echo "- p1: $p1"
    echo "- p2: $p2"
    echo
    if [[ "$p0" -gt 0 || "$p1" -gt 0 ]]; then
      echo "## Gate Status"
      echo "BLOCKED: open P0/P1 findings detected."
    else
      echo "## Gate Status"
      echo "PASS: no open P0/P1 findings detected."
    fi
    echo
    echo "## High Severity Findings"
    awk -F'\t' '$8=="P0" || $8=="P1" {printf("- %s | ref=%s | commit=%s | %s:%s | %s\n",$8,$2,$3,$4,$5,substr($6,1,180))}' "$DEDUP_FILE"
  } > "$TRIAGE_FILE"
}

write_remediation_plan() {
  local p0 p1
  p0="$(awk -F'\t' '$8=="P0" {c++} END {print c+0}' "$DEDUP_FILE")"
  p1="$(awk -F'\t' '$8=="P1" {c++} END {print c+0}' "$DEDUP_FILE")"

  {
    echo "# Remediation Plan"
    echo
    echo "## Policy"
    echo "- Block release/merge for any open P0/P1 finding."
    echo "- P2 findings are allowed with documented rationale and owner."
    echo
    echo "## Immediate Actions"
    echo "1. Remove exposed data from branch tips."
    echo "2. Rewrite affected branch/tag history if exposure is historical."
    echo "3. Force-push rewritten refs after coordination."
    echo "4. Rotate compromised credentials/tokens immediately."
    echo "5. Re-run audit and confirm no re-detection."
    echo
    echo "## Current Counts"
    echo "- P0: $p0"
    echo "- P1: $p1"
    echo
    echo "## Open P0/P1 Backlog"
    awk -F'\t' '$8=="P0" || $8=="P1" {printf("- [%s] ref=%s commit=%s file=%s:%s\n",$8,$2,$3,$4,$5)}' "$DEDUP_FILE"
  } > "$REMEDIATION_FILE"
}

write_verification() {
  local p0 p1
  p0="$(awk -F'\t' '$8=="P0" {c++} END {print c+0}' "$DEDUP_FILE")"
  p1="$(awk -F'\t' '$8=="P1" {c++} END {print c+0}' "$DEDUP_FILE")"

  {
    echo "run_id=$RUN_ID"
    echo "mode=$MODE"
    echo "generated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "p0=$p0"
    echo "p1=$p1"
    if [[ "$p0" -eq 0 && "$p1" -eq 0 ]]; then
      echo "result=PASS"
      echo "message=no P0/P1 re-detections"
    else
      echo "result=FAIL"
      echo "message=open P0/P1 findings remain"
    fi
  } > "$VERIFY_FILE"
}

scan_tree_all_refs() {
  append_raw_header "TREE-LEVEL SCAN PER REF"
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    scan_git_object "tree" "$ref" "$ref" "HEAD"
  done < "$REFS_FILE"
}

scan_history_all_commits() {
  append_raw_header "HISTORY-LEVEL SCAN ACROSS ALL REFS"
  git -C "$REPO_DIR" rev-list --all > "$COMMITS_FILE"
  while IFS= read -r commit; do
    [[ -z "$commit" ]] && continue
    scan_git_object "history" "$commit" "history" "$commit"
  done < "$COMMITS_FILE"
}

scan_pr_gate() {
  append_raw_header "PR GATE CHANGED FILE SCAN"
  git -C "$REPO_DIR" diff --name-only "$TARGET_REF...HEAD" > "$CHANGED_FILE" || true
  if [[ ! -s "$CHANGED_FILE" ]]; then
    echo "No changed files compared to $TARGET_REF" >> "$RAW_FILE"
    return
  fi

  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    case "$rel" in
      *node_modules*|*dist/*|*build/*|*package-lock.json)
        continue
        ;;
    esac
    local abs="$REPO_DIR/$rel"
    [[ -f "$abs" ]] || continue
    local out
    out="$(rg -n -e "$COMBINED_RE" "$abs" || true)"
    [[ -z "$out" ]] && continue
    while IFS= read -r line_match; do
      [[ -z "$line_match" ]] && continue
      echo "pr-gate|$line_match" >> "$RAW_FILE"
      local rest line_no snippet
      rest="${line_match#*:}"
      line_no="${rest%%:*}"
      snippet="${rest#*:}"
      emit_match "pr-gate" "HEAD" "HEAD" "$rel" "$line_no" "$snippet" "changed file pr gate"
    done <<< "$out"
  done < "$CHANGED_FILE"
}

usage() {
  cat <<USAGE
Usage: $(basename "$0") [baseline|weekly|monthly|pr-gate]

Environment:
  AUDIT_ROOT=/Users/danpeguine/Projects/.clawpilot-audit
  RUN_ID=run-YYYYMMDDTHHMMSSZ
  TARGET_REF=origin/main         # used in pr-gate mode
  ENFORCE_GATE=false             # true to fail command on open P0/P1
USAGE
}

mkdir -p "$RUN_DIR"
: > "$RAW_FILE"
: > "$NORM_FILE"

case "$MODE" in
  baseline|weekly|monthly|pr-gate)
    ;;
  *)
    usage
    exit 1
    ;;
esac

log "mode=$MODE"
log "run_dir=$RUN_DIR"

append_raw_header "PHASE 1: BASELINE INVENTORY"

# Fetch/prune/tags and freeze refs in scope.
git -C "$REPO_DIR" fetch --all --prune --tags

git -C "$REPO_DIR" for-each-ref --format='%(refname:short)' \
  refs/heads refs/remotes/origin refs/tags > "$REFS_FILE"

{
  echo "repo=$REPO_DIR"
  echo "mode=$MODE"
  echo "generated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rev_list_count=$(git -C "$REPO_DIR" rev-list --count --all)"
  echo
  git -C "$REPO_DIR" count-objects -v
} >> "$RAW_FILE"

case "$MODE" in
  baseline)
    scan_tree_all_refs
    scan_history_all_commits
    scan_existing_script_baseline
    scan_manual_files
    ;;
  weekly)
    scan_tree_all_refs
    scan_existing_script_baseline
    scan_manual_files
    ;;
  monthly)
    scan_tree_all_refs
    scan_history_all_commits
    scan_existing_script_baseline
    scan_manual_files
    ;;
  pr-gate)
    printf 'HEAD\n%s\n' "$TARGET_REF" > "$REFS_FILE"
    scan_pr_gate
    scan_existing_script_baseline
    scan_manual_files
    ;;
esac

generate_csv
write_triage
write_remediation_plan
write_verification

p0_count="$(awk -F'\t' '$8=="P0" {c++} END {print c+0}' "$DEDUP_FILE")"
p1_count="$(awk -F'\t' '$8=="P1" {c++} END {print c+0}' "$DEDUP_FILE")"

log "findings_csv=$CSV_FILE"
log "p0=$p0_count p1=$p1_count"

if [[ "$MODE" == "pr-gate" || "$(printf "%s" "$ENFORCE_GATE" | tr "[:upper:]" "[:lower:]")" == "true" ]]; then
  if [[ "$p0_count" -gt 0 || "$p1_count" -gt 0 ]]; then
    log "gate=BLOCKED"
    exit 2
  fi
fi

log "done"
