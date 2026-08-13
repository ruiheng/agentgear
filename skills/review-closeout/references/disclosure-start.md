---
skill-selector: start
selector-summary: Complete review-closeout instructions, part 1.
---

# Review Closeout

Extract a closeout summary from a full review report.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Purpose

Use this skill when an accepted full review report exists and only remaining follow-up items are needed.
For UI-related tasks, carry forward any UI confirmation package that exists in the accepted review context into closeout output.
Closeout should also give planner a compact summary of residual accepted findings that may need later tracking.

Input gate:
- run only after acceptance by workflow policy or explicit decision for a task review with complete Handoff; return `integration_final` / `standalone` results directly to requester
- do not run this skill for pending review, iteration requests, or any report that still has unresolved must-fix items
- determine eligibility from accepted review context and workflow policy, not from session title naming

## Input

Provide the accepted full review report text.

## Output Mode (Fixed)

- output directly in response
- multi-agent mode: also deliver the closeout summary to planner through the workflow transport
- keep output compact and copy/paste friendly
- keep closeout in message body instead of a generated Markdown handoff file

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/diagnostics` for shared protocol:
- `Multi-Agent Mode Detection`
- `Context Resolution Priority`
- `Error Handling and Diagnostics`

Skill-specific context resolution:
- `task_id`: explicit -> review report text -> ask
- `planner_session_id`: explicit -> review context -> ask
- `planner_workspace`: explicit -> accepted review report `Planner workspace` -> review context -> planner session-manager path -> ask
- `closeout_sender_session_id`: explicit -> current session id -> review context -> ask
- `closeout_sender_role`: explicit -> current workflow role -> review context -> default `closeout_executor`
- `reviewer_session_id`: explicit -> accepted review report `From` header -> review context -> ask
- `coder_session_id` (optional): explicit -> accepted review report `To: coder` header -> review context; omit when the requester is not a coder
- `session_host`: explicit -> accepted review report `Session host` -> review context -> ask
- `review_lane`: explicit -> accepted report/context -> require `task`
- `workflow_policy` (optional): explicit -> review/report context -> default unattended
- `special_requirements` (optional fallback): explicit -> review/report context -> omit
- `workspace_handoff`: complete -> preserve; missing/partial -> report blocker; do not infer
- `start_branch`, `integration_branch`, `task_branch`: explicit -> review report text -> ask

Handoff gate:
- require complete Handoff and recorded Branch Plan; send `closeout_delivered`

Branch-plan rule with a Handoff:
- do not infer, rename, or repair branch plan during closeout
- use the recorded branch plan from the accepted review report unchanged
- if recorded `integration_branch` looks like `task/*`, treat the branch plan as invalid and ask for the real integration branch
- if any branch-plan field is missing, ask one short clarification question instead of guessing

If required values are resolved:
1. normalize identity values before any comparison:
   - resolve `planner_session_id` / `closeout_sender_session_id` / `reviewer_session_id` and any present `coder_session_id` refs to real ids via `session_resolve`
   - if normalization fails for required identity, ask one short clarification question before sending
2. choose message action and subject:
   - `closeout_delivered`; `closeout delivered: <task_id>`
3. send mode:
   - if `closeout_sender_session_id == planner_session_id`, skip cross-session delivery and continue locally
   - otherwise send the selected action to planner through `waypost_send`
4. use `waypost`
5. first call `session_require` with:
   - `session_id = <planner_session_id>`
   - `workdir = <planner_workspace>`
   - do not use the reviewer/current workspace unless it is explicitly the planner workspace
   - retain the returned planner Waypost address
6. use `waypost_send` with:
   - `from_address = <current bound closeout-sender Waypost address>`
   - `to_address = <returned planner Waypost address>`
   - `subject = <selected subject>`
   - `body = <closeout message body>`

Recommended subjects:
- `closeout delivered: <task_id>`

## Extraction Rules

Inclusion-first policy:

1. Always keep non-empty items from:
- `Critical Issues`
- `Design Concerns`
- `Minor Suggestions`
- `Verification Questions`
- `UI Manual Confirmation Package`
- `User Decision Summary`
- with Handoff: `Recorded Branch Plan`, `Workspace Handoff`

Planner handoff rule:
- when closeout happens after acceptance, convert surviving non-blocking findings into planner-usable follow-up input instead of leaving them as raw review debris
- preserve whether each item looks like `progress/todo`, `next task`, or `no extra tracking`

2. Request/security checks:
- drop `PASS`
- keep `FAIL` and `UNKNOWN`

3. None handling:
- drop `None.` placeholders
- if section has both `None.` and real items, keep real items

4. Wording safety:
- preserve technical meaning
- keep file paths / line references
- report only issues supported by the review report

## Rendering Rules (No Empty Sections)

Bucket order:
1. `Critical Issues`
2. `Design Concerns`
3. `Residual Follow-up For Planner`
4. `Minor Suggestions`
5. `Verification Questions`
6. `User Decision Summary`
7. `UI Manual Confirmation Package`
8. `Remaining Check Alerts (FAIL/UNKNOWN Only)`

Rules:
- render section only when it has at least one item
- never output empty headings
- if all buckets are empty:

```markdown
### Review Closeout
No actionable items.
```

## Continue

Retrieve `agentgear skill get review-closeout/continue-1` before proceeding.
