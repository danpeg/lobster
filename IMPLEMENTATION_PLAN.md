# Lobster Implementation Plan for Codex

Based on codebase analysis of `github.com/danpeg/lobster` branch `codex/lobster-prompt-mode-privacy`.

---

## Files to Modify

### 1. `services/clawpilot-bridge/prompts/lobster.md`
**Changes: Medium complexity**

- Add "MEETING_START_PROMPT" section with human-friendly welcome message (copilot leads with a question)
- Add "STATUS_FEEDBACK" section with text+emoji templates
- Add "UNCERTAINTY_TRIGGERS" section listing hedging phrases and proactive responses
- Add "MODE_SUGGESTION_TRIGGERS" section with phrases that trigger mode suggestions
- Add "COMPANION_MODE" overlay for all-day life mode (30-min check-ins, end-of-day summary)
- Update mode list to include: brainstorm, weekly, standup, sales, catchup, companion

### 2. `services/clawpilot-bridge/server.js`
**Changes: Large complexity**

**Meeting start (no JSON):**
- Find `handleBotStatus` function for `bot.in_call_recording` event
- Replace JSON output with call to `buildMeetingStartMessage()` that returns human-friendly text
- Add `buildMeetingStartMessage(mode, audience)` function that returns formatted welcome

**Status feedback (never silent):**
- Add `lastCopilotMessageTime` tracking variable
- Add `statusPingIntervalMs` (default 60000) from env
- In main transcript handler, check if `Date.now() - lastCopilotMessageTime > statusPingIntervalMs`
- If true, send a text+emoji status ping: "📝 Still here — [1-line summary]"
- Add `buildStatusPing(recentContext)` function

**Proactive on uncertainty:**
- Add `HEDGING_PHRASES` array: ["i don't know", "i'm not sure", "maybe", "possibly", "not certain"]
- In transcript handler, check if speaker text matches hedging patterns
- If match, add proactive offer to response: "Want me to look that up?" / "I can research that"

**Mode suggestions:**
- Add `MODE_TRIGGER_PHRASES` map: {"how was the week": "weekly", "what's blocking": "standup", etc}
- In transcript handler, check for trigger phrases when mode doesn't match
- If mismatch, send suggestion: "💡 This sounds like a weekly check-in. Switch to weekly mode?"

**Companion mode:**
- Add `companionCheckInIntervalMs` (default 1800000 = 30 min)
- Add `companionLastCheckInTime` tracking
- Add `companionCapturedItems` array (tasks, ideas, questions)
- In companion mode, accumulate items and send periodic check-ins
- Add `buildCompanionCheckIn()` and `buildCompanionDaySummary()` functions

### 3. `packages/clawpilot-plugin/index.js`
**Changes: Small complexity**

- In `action === 'status'` handler, format response as human-readable text, not JSON
- Change: `return { text: \`ClawPilot status:\n${JSON.stringify(status, null, 2)}\` }` → formatted text
- Add new function `formatStatusResponse(status)` that returns readable lines

### 4. `services/clawpilot-bridge/.env.example`
**Changes: Small complexity**

Add new env vars:
```
# Status feedback interval (ms)
STATUS_PING_INTERVAL_MS=60000

# Companion mode check-in interval (ms)
COMPANION_CHECKIN_INTERVAL_MS=1800000
```

### 5. `scripts/bootstrap-recall.sh` (onboarding)
**Changes: Medium complexity**

- Add step to send "hello post" after successful setup
- Hello post introduces Lobster, explains modes, shows available commands
- Add Tailscale recommendation with setup guidance
- Add validation step to confirm webhook is reachable

### 6. `README.md`
**Changes: Small complexity**

- Add "Companion Mode" to modes documentation
- Add section on onboarding flow
- Document new env vars
- Update command examples

### 7. `qa/prelaunch-manual-test-plan.md`
**Changes: Small complexity**

Add test cases:
- [ ] Meeting start shows human-friendly welcome, not JSON
- [ ] Status ping appears after 60s of copilot silence
- [ ] Uncertainty phrase triggers proactive help offer
- [ ] Mode suggestion appears when conversation shifts
- [ ] Companion mode sends 30-min check-ins
- [ ] `/clawpilot status` returns formatted text, not JSON

---

## Implementation Order

1. **P0 - lobster.md prompt updates** (foundation for behavior changes)
2. **P0 - server.js meeting start** (no JSON, human-friendly)
3. **P0 - plugin status formatting** (no JSON in status command)
4. **P1 - server.js status ping** (feedback loop)
5. **P1 - server.js uncertainty triggers** (proactive help)
6. **P1 - server.js mode suggestions** (smart behavior)
7. **P1 - server.js companion mode** (new mode)
8. **P2 - bootstrap onboarding** (hello post, Tailscale)
9. **P2 - docs and QA updates**

---

## Dependencies

- Items 2-7 depend on item 1 (prompt updates)
- Item 7 (companion) is independent and can be parallelized
- Item 8 (onboarding) is independent
- Item 9 (docs) depends on all others

---

## Estimated Effort

| Item | Files | Complexity | Est. Time |
|------|-------|------------|-----------|
| Prompt updates | 1 | Medium | 1-2 hours |
| Meeting start | 1 | Medium | 1 hour |
| Plugin status | 1 | Small | 30 min |
| Status ping | 1 | Medium | 1-2 hours |
| Uncertainty triggers | 1 | Medium | 1 hour |
| Mode suggestions | 1 | Medium | 1 hour |
| Companion mode | 1 | Large | 2-3 hours |
| Onboarding | 1 | Medium | 1-2 hours |
| Docs/QA | 2 | Small | 1 hour |

**Total: ~10-14 hours**

---

## Notes for Codex

- Branch: `codex/lobster-prompt-mode-privacy`
- Test after each change with `npm run test:live`
- Keep changes focused - one feature per commit
- Update CHANGELOG.md with each feature
