---
name: dispatch-plan
description: Send a goal to a planner.
---

# Dispatch Plan

Send one supervisor-assigned goal to a planner session.
This creates one planner lane or resumes one existing lane by real `planner_session_id`.

Workflow protocol baseline: use the `multi-agent-protocol` skill.

## Inputs

- `plan_id`
- `supervisor_session_id`
- `workspace`
- `integration_branch` (planner-owned branch for this dispatched plan; must exist before send)
- optional `review_base` source ref (resolve and store its commit OID for final integration review)
- `goal`
- optional `planner_tool`
- optional `planner_tool_profile`
- optional `per_task_review`
- optional `final_review`
- optional `summary`
- optional `special_requirements`

When resuming an existing planner lane:
- `planner_session_id`

When allocating a new planner lane:
- optional `planner_session_ref`

## Rules

- one planner lane owns one session, workspace lifecycle, integration branch, and serial task decomposition in one workspace
- set `planner_workspace = worker_workspace = workspace`; do not switch workspace or start another active lane there except an explicit resume
- workspace reservation records prepare task closeout; they do not schedule planner-lane exclusivity
- create the planner as a child of the supervisor through the selected session host; do not expose host grouping in the workflow contract
- when creating a new planner session and no planner title/ref is provided, use `planner-YYYYMMDD-HHMM-<slug>`; do not use bare `planner`
- `integration_branch` is the planner-owned branch for this dispatched plan, not the supervisor landing branch
- for a new plan, resolve `source_ref`: explicit `review_base` -> current supervisor `HEAD`; run `git rev-parse --verify <source_ref>^{commit}`, store its OID as `review_base`, and create a fresh `integration_branch` from it before sending
- on resume, preserve the recorded `review_base`; never derive a new one
- do not silently reuse an existing planner integration branch from an earlier run; reuse is allowed only when the user explicitly says this dispatch is resuming that same unfinished plan
- if the requested or derived `integration_branch` already exists and resume was not explicit, choose a new branch name or ask; do not dispatch onto an old branch tip
- create the planner integration branch without switching the supervisor worktree; start from the recorded `review_base` OID
- if `planner_tool` is omitted, honor an explicit `planner_tool_profile` first; otherwise use recorded workflow continuity or resolve the planner role default through the shared tool-resolution contract
- when `planner_session_id` is already known, treat the planner session as existing and carry forward its recorded launch metadata; do not resolve a replacement
- default `per_task_review = required`
- default `final_review = skip`
- blockers stop with a user question; do not add blocker message to supervisor
- planner is not done when implementation is done; planner is done only after the assigned goal is complete or blocked and the required final report has been sent to supervisor
- normal path: resolve inputs, create or require the planner session through MCP, then send the message body
- do not inspect `--help`, environment variables, or repo docs first unless the MCP create/require or send step actually fails

## Waypost Message Body Template

```markdown
Task: <plan_id>
Action: execute_plan
From: supervisor <supervisor_session_id>
To: planner {{TO_SESSION_ID}}
Planner: {{TO_SESSION_ID}}
Round: 1

## Summary
[One-line plan summary]

## Goal
[What this planner must finish in this workspace]

## Workspace Contract
- Workspace path: [workspace]
- Integration branch: [integration_branch]
- Review base: [full commit OID]
  Source commit used to create this integration branch; use it for final integration review.
- Execution model: planner-owned decomposition; serial tasks in one workspace
- Completion rule: planner is complete only after finishing the assigned goal and successfully sending `plan_report_delivered` to supervisor

## Review Policy
- Per-task review: [required | skip]
- Final integration review: [required | skip]

## Planning Contract
- Planner owns task decomposition and sequencing inside this workspace
- Keep task execution serial in this workspace
- Do not rely on workspace reservation records as cross-task locks; prepare the workspace again for each task closeout path
- Use `delegate-task` Selection-Only: Direct only after its gate passes; otherwise use a native harness, independently justified persistent Waypost session via `delegate-code-task`, or planner-owned nonpersistent delivery. Never generic Dispatch.
- Planner owns branch, commit, review, and closeout for local, harness, and nonpersistent delivery.
- Planner-local execution and any later delegated work both stay in the one workspace recorded above
- Any self-implemented code change still requires workspace prep, explicit task branch from `integration_branch`, commit, any required review, closeout merge, and final supervisor report
- Routine branch, commit, review-request, closeout, and final-report actions are workflow-authorized; ask the user only for real scope/tradeoff decisions or explicit human gates
- Ask the user directly if the goal cannot be completed without a real scope or tradeoff decision

## Special Requirements
[only when present]
```

## Waypost Message Send

1. resolve the current supervisor branch; if the worktree is detached or the landing branch is unclear, stop and ask instead of guessing
2. for a new plan, resolve `source_ref = explicit review_base -> current supervisor HEAD`; set `review_base = git rev-parse --verify <source_ref>^{commit}`. On resume preserve recorded `review_base`
3. resolve `workspace`
4. set internal `planner_workspace = workspace` and `worker_workspace = workspace`
5. resolve `planner_session_ref`; when creating a new planner and no existing ref/id is provided, generate `planner-YYYYMMDD-HHMM-<slug>` from the workspace or goal
6. resolve planner launch policy only when allocating a new planner lane, following the shared tool-resolution contract for role `planner`
   - if `planner_session_id` is already known, skip this resolution step and carry forward the existing planner launch metadata
   - if explicit `planner_tool` is provided, preserve it unchanged as `planner_tool_cmd`
   - otherwise, if explicit `planner_tool_profile` is provided, resolve role `planner` with that profile
   - otherwise, if workflow context records a supervisor launch candidate for continuity, reuse it
   - otherwise resolve the default role `planner` command
   - record both `planner_tool_profile` and `planner_tool_cmd`
7. resolve `integration_branch`
   - explicit branch name wins
   - otherwise derive a fresh planner-owned branch name from `plan_id`; prefer `plan/<plan_id>`
8. for a new plan, create the planner integration branch from `review_base` OID before dispatch
   - do not switch the supervisor worktree onto that branch
   - if the preferred branch name already exists and resume was not explicit, choose a new unique suffix instead of reusing that ref
   - on resume, preserve the recorded `review_base`
9. call `waypost_status` and resolve the planner target by its real id or ref.
10. if this dispatch allocates a new planner lane, require the supervisor parent, then call `session_create` for `<planner_session_ref>` with the selected opaque launch candidate, the parent real id, and `<planner_workspace>`.
11. otherwise call `session_require` with the returned host, real planner id, and `<planner_workspace>`.
12. record the returned host, real id, and sole address as the authoritative planner route for later workflow turns.
13. fill `{{TO_SESSION_ID}}`
14. send with:
   - `from_address = waypost_status.default_sender`
   - `to_address = <planner returned address>`
   - `subject = "plan dispatch: <plan_id>"`
   - `body = <execute-plan message body>`
15. follow the shared Async sender rule for planner reports

Rules:
- use `session_create` only when allocating a new planner lane; use `session_require` when resuming an existing planner session
- new planner lanes must use a verified same-host supervisor parent; do not rely on host grouping
- after a planner lane is created, later workflow turns must reuse the real `planner_session_id`; do not resume a normal workflow turn by `planner_session_ref`
- do not create planner sessions through a host CLI in the normal path
- treat MCP session create/require as a synchronous step; wait for it to return before composing or sending message content
- record selected resolver metadata in workflow context; use its opaque values only for session creation and recovery
