---
skill-selector: continue-1
selector-summary: Complete review-code instructions, part 2.
---

## UI-Change Detection and Confirmation Policy

Detect likely user-facing UI changes. Human confirmation is opt-in by workflow policy, not the default.

Heuristics:
- frontend/template/style files changed (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.html`, `*.css`, `*.scss`, `*.less`)
- UI routes/pages/components changed
- design token/theme/layout/visible text changed
- browser-tool validation required

Policy rules:
- default: record detected UI impact; do not require human confirmation before closeout
- override via `workflow_policy.ui_manual_confirmation`:
  - `skip` (default)
  - `required`
  - `auto`
- use `required` only when the user or workflow policy explicitly wants a human UI gate
- `auto` is an explicit heuristic mode, not the default

## What Not to Review

- syntax validity (linters)
- style/formatting (formatters)
- comment/string typos

## Verification Reuse Rule

- Treat `Checks Already Run` in `review_requested` as the primary record of coder-run verification
- Usually reuse recorded lint, build/link, compile/type-check, and test results instead of rerunning the same slow checks
- Rerun only when the recorded evidence is missing, stale, too broad, too narrow, suspicious, or does not answer the actual review risk
- When rerunning is necessary, prefer the narrowest command that answers the open question

## Output Format

Use this structure as the full review report. For a rework result, use the exact `Action: rework_required` line. For an accepted stop recommendation, use the exact `Action: stop_recommended` line.
Omit `### User Decision Summary` when no user scope decision exists.

```markdown
Task: <task_id>
Action: rework_required
From: reviewer <reviewer_session_id>
To: <requester_role> <requester_session_id>
Review lane: <task | integration_final | standalone>
Round: <round>

### Summary
[APPROVED / NEEDS_REVISION]: Brief rationale (1-2 sentences)

### Request Completeness Check
- Scope clarity: [PASS / FAIL]
- Branch plan / Handoff: [PASS / FAIL / N/A]
- Intent clarity: [PASS / FAIL]
- Behavior/compatibility constraints: [PASS / FAIL]
- Verification evidence: [PASS / FAIL]
If any FAIL, explain why in `Critical Issues`.

### Intent And Constraints
- Intended change: [summary]
- Must-preserve behavior: [summary]
- Non-goals / out-of-scope: [summary or `None`]

### User Decision Summary
[all user scope decisions known at this round; the final task report summarizes the complete list for planner]

### Workflow Policy
[resolved workflow policy]

### Critical Issues
Must fix before merge:
- [ ] **[CATEGORY]**: Description | Suggestion: How to fix

### Design Concerns
Architecture/decision questions:
- **[Concern]**: Description | Suggestion: Alternative approach

### Minor Suggestions
Optional improvements:
- [ ] Description

### Security Check
- Injection risks: [PASS / FAIL / UNKNOWN] - [brief basis]
- Unsafe data exposure: [PASS / FAIL / UNKNOWN] - [brief basis]
- Input validation: [PASS / FAIL / UNKNOWN] - [brief basis]

### Verification Questions
For the implementer/author:
- [Q1] Question

```

For an accepted stop recommendation, use the same report structure with this envelope header instead:

```markdown
Action: stop_recommended
```

For `task`, insert after `Round`:

```markdown
Session host: <session_host>
```

When UI impact is detected or a human UI gate applies, append:

```markdown
### UI Manual Confirmation Package
- UI impact: [detected]
- Changed UI surfaces: [routes/pages/components]
- Manual check steps (human-run): [short checklist]
- Expected visible outcomes: [what user should see]
- Notes: [optional]
```

For `task` / `integration_final`, insert after `To`:

```markdown
Planner: <planner_session_id>
Planner workspace: <planner_workspace>
```

For task, insert this after `Intent And Constraints`:

```markdown
### Recorded Branch Plan
- Start branch: [start_branch]
- Integration branch: [integration_branch]
- Task branch: [task_branch]
- Stability rule: preserve this Branch Plan unchanged for the dispatch; return requested changes to planner before review
```

For task, append its Handoff unchanged after `Recorded Branch Plan`:

```markdown
### Workspace Handoff
- Worker workspace: [worker_workspace]
- Task dir: [task_dir]
- Workspace lifecycle: [shared; cleanup=none | temporary; cleanup=planner]
```

For `integration_final` / `standalone`, omit Workspace Handoff and task Branch Plan.

For `integration_final`, insert after `Intent And Constraints`:

```markdown
### Final Review Scope
- Integration branch: [scope target]
- Review base: [scope base]
```

## Continue

Retrieve `agentgear skill get review-code continue-2` before proceeding.
