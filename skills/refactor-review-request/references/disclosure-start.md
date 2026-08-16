---
skill-selector: start
selector-summary: Complete refactor-review-request instructions, part 1.
---

# Refactor Review Request

Generate a concise Waypost message that asks a refactor reviewer to inspect code for duplication and simplification opportunities.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Inputs

- `task_id`
- `requester_session_id`
- `requester_role`
- `scope`
- `refactor_goal`
- optional `constraints`
- optional `original_task`
- optional `current_pain_points` (observed symptoms only; no diagnosis or prescribed refactor)
- optional `reviewer_tool`
- optional `reviewer_tool_profile`
- optional `planner_session_id`
- optional `round`

Later rounds / existing reviewer lane:
- `refactor_reviewer_session_id`

Round `1` or new reviewer allocation:
- optional `refactor_reviewer_session_ref`

## Continuity Rule

- round `1` uses the full body below
- later rounds to the same refactor-reviewer session send only the delta since the previous round
- if reviewer continuity changed or is unknown, fall back to the full body

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/session-host multi-agent-protocol/tool-resolution` for shared protocol.

Skill-specific context resolution:
- `task_id`: explicit -> workflow context -> ask
- `requester_session_id`: explicit -> current session id -> ask
- `requester_role`: explicit -> infer from current workflow stage -> default `requester`
- `planner_session_id`: explicit -> workflow context -> default `N/A`
- `refactor_reviewer_session_id`: explicit actual id -> workflow context actual id -> ask
- `refactor_reviewer_session_ref`: explicit -> workflow context -> default `refactor-reviewer-<task_id>`
  - use only when allocating a new reviewer session before the first send
- `scope`: explicit -> workflow context -> ask
- `refactor_goal`: explicit -> workflow context -> default `identify duplication and simplification opportunities`
- `reviewer_tool_profile`: explicit -> workflow context -> omit when `reviewer_tool` is already a full command -> default resolver role default `reviewer`
- `reviewer_tool_cmd`: explicit full command -> workflow context resolved command -> `agentgear skill get multi-agent-protocol/tool-resolution` for role `reviewer`
- `round`: explicit -> workflow context -> default `1`

## Waypost Message Body

Provide scope, review goal, constraints, and observed symptoms, not a diagnosis or candidate solution.
- Let the reviewer identify causes, opportunities, and sequencing independently.
- Treat any requested focus as optional emphasis that does not limit the full scoped review.

Round `1` or new reviewer session: use the full body below.

```markdown
Task: <task_id>
Action: refactor_review_requested
Planner: <planner_session_id_or_N/A>
Round: <round>

## Summary
[One-line refactor review request summary]

## Scope
[Files, module, branch, or code area in scope]

## Review Goal
[What outcome or question should be assessed; do not prescribe a refactor]

## Original Task
[Original task or `N/A`]

## Constraints
- [constraint or `None`]

## Observed Symptoms
- [Factual pain signal or `None`; do not supply a diagnosis]

## Review Boundaries
- advisory only
- no implementation
- preserve existing behavior unless explicitly stated otherwise

```

Round `>1` to the same reviewer session: send only delta.

```markdown
Task: <task_id>
Action: refactor_review_requested
Planner: <planner_session_id_or_N/A>
Round: <round>

## Summary
[One-line delta summary]

## Delta Since Last Round
- Scope changes: [what changed or `None`]
- New observed symptoms: [what changed or `None`]
- Constraints changed: [what changed or `None`]
- Previous advice adopted or rejected: [brief summary or `N/A`]

## Optional Review Focus
[Unresolved question deserving emphasis or `None`; do not limit the full scoped review]

```

## Waypost Message Send

Recommended subject:
- `refactor review request: <task_id> r<round>`

Use the `waypost` MCP tools:
1. use `waypost`
2. call `session_require` for the reviewer id or ref with the known host and `workdir = <current workspace>`.
3. on `ready`, reuse its returned host, real id, and address.
4. on `not_found`, resolve role `reviewer`, then call `session_create` for `<refactor_reviewer_session_ref>` with the selected opaque launch candidate and recorded requester parent. It verifies that parent; do not preflight it with `session_require`. Record the returned host, real id, and sole address for later turns.
5. use the returned real id as the authoritative `refactor_reviewer_session_id`
6. compose the final body and call `waypost_send` with:
   - `from_address = waypost_status.default_sender`
   - `to_address = <refactor reviewer returned address>`
   - `subject = "refactor review request: <task_id> r<round>"`
   - `body = <refactor review request body>`

## Rules

- request advisory refactor review only
- keep the body self-contained
- do not ask the reviewer to implement changes
- focus on one coherent code area or one review goal per request
- later rounds to the same reviewer should be delta-only
- if reviewer continuity changes, resend full context
- create new refactor-reviewer sessions through `session_create` with a verified requester parent
- after the first create step, later workflow turns must reuse the real `refactor_reviewer_session_id`; do not fall back to `refactor_reviewer_session_ref`
- follow the shared Async sender rule for the advisory report
