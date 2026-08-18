---
skill-selector: start-plan
selector-summary: Complete execute-plan instructions, part 1.
selector-aliases: execute-plan/start, action:execute_plan
---

# Execute Plan

Execute one supervisor-provided goal inside one workspace.
This session owns one planner lane.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Input

Provide `execute_plan`, or a matching `integration_final` result plus plan context.

## Core Model

- this planner lane owns one session, workspace lifecycle, integration branch, review base, and internal task decomposition; tasks execute serially in one workspace
- workspace reservation records are prepared per task and released by closeout; planner-lane exclusivity comes from this serial execution contract, not from keeping a record across task gaps
- planner default role is coordinator, not coder
- the planner should auto-advance whenever the next step is clear
- if a blocker cannot be resolved locally, stop and ask the user directly
- do not send routine blocker message to supervisor
- select code tasks through `delegate-task` Selection-Only; persistent Waypost code work uses `delegate-code-task`
- code-changing tasks are complete only after commit, any required review, closeout merge, and progress recording
- claiming `execute_plan` does not require planner to implement code personally; dispatch, review, closeout, and final report still count as completing the workflow
- planner is not done when implementation is done; planner is done only after one final `plan_report_delivered` message is successfully sent to supervisor

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol` for shared protocol.

Skill-specific context resolution:
Final-review continuation:
- recover all plan fields from matching `execute_plan` context by plan/task and planner; review result supplies outcome only, never supervisor routing
- miss/ambiguity: defer; do not send final report

- `plan_id`: explicit -> message body -> ask
- supervisor reply route: final-review continuation -> matching/recovered plan context; otherwise received `sender_address`
- `supervisor_session_id`: explicit -> message body `Supervisor session` -> matching/recovered plan context -> ask
- `planner_session_id`: explicit -> message body `Planner` header -> current session id -> ask
- `workspace`: explicit -> message body `Workspace path` -> ask
- `planner_workspace`: derive internally from `workspace`
- `worker_workspace`: derive internally from `workspace`
- `integration_branch`: explicit -> message body -> ask
  - this is the already-created planner-owned branch for this dispatched plan, not the supervisor landing branch
- `review_base`: explicit -> message body `Review base` -> ask
  - immutable source commit for `integration_branch`; use only for final integration review
- `per_task_review`: explicit -> message body -> default `required`
- `final_review`: explicit -> message body -> default `skip`

## Execution Flow

1. read the goal, workspace contract, and review policy from the message body
   - set internal `planner_workspace = workspace` and `worker_workspace = workspace`
2. run `agentgear run multi-agent-protocol prepare-workspaces.mjs --worker-workspace <worker_workspace> --planner-workspace <planner_workspace> --integration-branch <integration_branch> --planner-session-id <planner_session_id> --supervisor-session-id <supervisor_session_id>`
3. decompose the goal into the smallest reasonable serial task sequence for this workspace
4. execute that task sequence serially
5. for each implementation task:
   - before starting the task, run workspace prepare for the recorded workspace and integration branch
   - use `delegate-task` Selection-Only; never generic Dispatch
   - use Direct Planner Implementation only when its local gate passes; otherwise use a native harness when available, a justified persistent Waypost worker via `delegate-code-task` (pass `session_reason` and `Per-task review`), or Planner-Owned Nonpersistent Fallback
   - a direct user-led host session is outside this workflow-owned delivery lane
6. cross-session work may take unbounded time; after sending it, follow the shared Async sender rule
   - for a persistent code worker, handle a later `code_delivery_complete` with `planner-closeout` before starting the next task; only skipped review may complete through it, while a blocker retains task state
7. when the goal is complete:
   - if `Final integration review: required`, run `review-request` with `task_id = plan_id`, branch target `integration_branch`, `base_branch = review_base`, `requester_role = planner`, and `review_lane = integration_final`
   - if that final review returns serious issues, decide whether to fix locally or spawn a new task; prefer a new task for non-trivial fixes
   - resume on its later result: `rework_required` returns to task selection; `work_accepted` or `abort_iteration` returns to planner decision-making
8. send one final `plan_report_delivered` message to supervisor; do not treat the plan as complete before this message send succeeds
9. after the final report is sent, report completion to supervisor

## Direct Planner Implementation

Use this only after `delegate-task` Selection-Only Use selects local execution. It is eligible only when all of the following hold:
- single local change
- no new cross-module behavior
- no schema, registry, or runtime contract change
- no new first-class model or state field
- no meaningful design choice remains
- narrow verification is sufficient
- delegation would be pure coordination overhead

If any condition fails, do not use the direct fast path: use Native Harness Implementation when available; use `delegate-code-task` only when a persistent host session has an independent lifecycle or user-interaction reason; otherwise use Planner-Owned Nonpersistent Fallback.

## Native Harness Implementation

Use this only after `delegate-task` Selection-Only Use selects a native harness subagent. Use Planner-Owned Code Delivery with the harness as executor. The harness owns bounded implementation, not branch, commit, review, or closeout ownership.

## Planner-Owned Nonpersistent Fallback

Use this when the task fails the direct gate, no native harness is available, and a persistent host session is not justified. The planner is the executor under Planner-Owned Code Delivery; create no worker session or Waypost task.

## Continue

Retrieve `agentgear skill get execute-plan/continue-1` before proceeding.
