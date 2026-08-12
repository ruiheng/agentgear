---
skill-selector: continue-1
selector-summary: Complete execute-plan instructions, part 2.
---

## Planner-Owned Code Delivery

Use this after direct, harness, or planner-owned fallback selection. The planner owns the task branch, delivery commit, review, and closeout.

1. use the already-prepared workspace from `Execution Flow`; never commit on detached `HEAD`
2. create an explicit `task_branch` from `integration_branch`
   - default: `task/<plan_id>-<short-slug>` or `task/<task_id>`
   - `task_branch` must differ from `integration_branch`
   - reuse an existing `task_branch` only when it is clearly the same unfinished task
3. run the selected executor:
   - planner: make the change in `worker_workspace`
   - harness: give it the recorded task branch, workspace, objective, and acceptance criteria; it may edit and validate, but must not switch branches or commit. Do not alter the shared workspace until it returns.
4. if a harness ran, confirm the recorded `task_branch` is still checked out
5. verify the result with the narrowest meaningful checks
6. stage and commit the task change without asking the user for routine commit confirmation
7. if `Per-task review: required`:
   - run `review-request` with `requester_role = planner`, `review_lane = task`, the recorded branch plan, workspace handoff (`worker_workspace`, `task_dir = worker_workspace`, `workspace_lifecycle = shared; cleanup=none`), and the delivery commit or task branch as scope
   - let `review-request` create or reuse the reviewer on demand with the verified planner parent
   - after `review-request` sends the request, follow the shared Async sender rule
   - when a later inbound reviewer acceptance produces `closeout_delivered`, handle it with `planner-closeout` before marking the task done
8. if `Per-task review: skip`, run workspace prepare for this planner-owned task, then run `planner-closeout-batch.mjs` directly with the recorded `task_branch`, `integration_branch`, `worker_workspace`, `planner_workspace`, `task_id`, and task dir before marking the task done; a persistent Waypost coder instead returns `code_delivery_complete` for `planner-closeout`
9. record the result under `Tasks Completed`

Planner-owned git writes, commits, review requests, and closeout are workflow-authorized for either executor.
Ask the user only for real scope/tradeoff decisions, explicit human gates, dirty-worktree conflicts, or branch ownership blockers.

## Decision Rules

- `delegate-task` Selection-Only owns execution-surface selection; `delegate-code-task` owns only persistent Waypost code work
- understanding the implementation does not by itself authorize direct implementation
- direct work needs local selection and its gate; otherwise use a harness, independently justified persistent host session, or nonpersistent fallback
- Planner-Owned Code Delivery owns branch, commit, review, and closeout for local, harness, and nonpersistent work; fallback creates no worker/session
- a persistent host session needs durable history, explicit control, or user-visible/intervenable execution; difficulty alone is not enough
- keep the decomposition local to this planner; supervisor assigns the goal, not the internal task breakdown
- do not treat completed implementation, review, or closeout as plan completion; the plan completes only after `plan_report_delivered` is successfully sent to supervisor
- if user input is needed for scope, priority, or tradeoff, ask the user directly and stop
- do not rely on `.agent-artifacts/planner-workspace.json` as a cross-task lock; each task that can reach closeout must prepare its own reservation first
- do not ask for routine confirmation before planner-owned branch, commit, review-request, closeout, or final-report actions

## Final Report Template

```markdown
Task: <plan_id>
Action: plan_report_delivered
From: planner <planner_session_id>
To: supervisor <supervisor_session_id>
Planner: <planner_session_id>
Round: final

## Summary
[Completed / blocked summary]

## Goal Status
- Outcome: [completed | blocked]
- Integration branch: [integration_branch]

## Tasks Completed
- <task_id or planner-defined step>: [result]

## Review Summary
- Per-task review policy used: [required | skip]
- Final integration review: [required | skip]
- Final review result: [not run | approved | needs follow-up]

## Open Items
- [item or `None`]
```

## Rules

- keep plan execution serial inside this workspace
- own the internal breakdown needed to complete the goal; do not ask supervisor to pre-split ordinary implementation tasks
- keep `worker_workspace` and `planner_workspace` equal for the full dispatched plan; do not introduce a second workspace
- preserve `integration_branch` and `review_base` for the full plan unless the user explicitly changes them
- treat `integration_branch` as the planner-owned branch prepared for this dispatched plan; do not reinterpret it as the supervisor landing branch and do not silently jump onto some older leftover branch
- run workspace prepare before each task that may later require closeout; treat the resulting detached-HEAD state in `worker_workspace` as authoritative until an explicit task branch is attached
- do not infer a task start point from current `HEAD`; use the explicit `integration_branch` from workflow context instead
- when self-implementing on the direct-work path, attach a real task branch from `integration_branch` before committing
- treat workspace prep as an early closeout viability gate too: if another worktree already holds `integration_branch` and planner closeout later needs to attach it here, stop immediately instead of letting the plan fail only at final closeout
- keep the planner workspace record aligned with the current planner session; if the workspace-prep script reports a live-session mismatch, stop instead of reusing the workspace
- pass `--override-workspaces` only after explicit user confirmation to replace the mirrored `planner-workspace.json` records
- do not run ad hoc workspace record cleanup; closeout helpers own release and `prepare-workspaces.mjs --release-workspaces` is only for explicit script-reported cleanup recovery
- do not naturally end after the last task if the final report to supervisor is still pending
- if this turn owns a claimed `execute_plan` delivery, complete the final report and the delivery lifecycle step before ending
