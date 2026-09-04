---
skill-selector: internal/dispatch-plan
selector-summary: Apply the internal supervisor-to-planner dispatch protocol, part 1.
---

# Dispatch Plan

Send one supervisor-assigned goal to a planner session.
This creates one planner lane or resumes one existing lane by real `planner_session_id`.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

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
- if `planner_tool` is omitted, honor an explicit `planner_tool_profile` first; otherwise use recorded workflow continuity or resolve the planner role default through `agentgear skill get multi-agent-protocol/tool-resolution`
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
Planner: {{TO_SESSION_ID}}
Supervisor session: <supervisor_session_id>
Round: 1

Apply the `route-waypost-action` skill.

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

## Continue

Retrieve `agentgear skill get multi-agent-protocol/internal/dispatch-plan/continue-1` before proceeding.
