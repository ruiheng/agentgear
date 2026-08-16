---
skill-selector: continue-2
selector-summary: Complete review-code instructions, part 3.
---

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/diagnostics` for shared protocol:
- `Multi-Agent Mode Detection`
- `Context Resolution Priority`
- `Error Handling and Diagnostics`

Skill-specific context resolution:
Review continuity:
- `review_task_context`: validate, retain as task-scoped planner context, acknowledge, and wait
- new/full `review_requested`: body starts a review; never use saved context
- delegated new/full `review_requested`: body plus the matching task-scoped planner context starts the review
- confirmed delta: `round >1`, round advances from the active review, and task/requester/reviewer/lane match. Body owns routing; use matching context only for omitted review frame
- unconfirmed delta: require full body, then treat it as new
- `browser_check_report`: match `Browser Check` to the sent check; its review frame owns requester routing. If context is lost, recover that check from history, then rebuild from full request + matching deltas.
- Miss/ambiguity: defer; require full request; never infer frame from report.

For `review_requested`, routing fields (`review_lane`, planner/requester, Branch Plan, Handoff) resolve `explicit -> body -> gate/default`; never saved context.
For a confirmed delta, review frame (scope, original task, unchanged intent/constraints, policy, requirements, checks) resolves `explicit -> body -> matching context`.
Run the completeness gate on resolved context, not the delta alone.

For delegated task review, original task, Special Requirements, and workflow policy resolve from the task-scoped planner context. Coder requests may carry User Decisions but must preserve planner routing, Branch Plan, and Workspace Handoff.

For `browser_check_report`, `explicit -> matching/recovered frame` owns all review routing/frame. Body supplies only envelope identity and browser evidence; never default lane or derive review context from it.

- `task_id`: explicit -> message body -> ask
- `browser_check_id` (browser report): required header -> matching sent check; never infer from task/round
- `reviewer_session_id`: explicit -> current bound Waypost session -> ask
- `session_host`: task -> message body `Session host` -> matched review context -> ask; other lanes -> omit
- `browser_tester_session_id` (optional): explicit actual id -> message/review context -> omit
- `browser_tester_session_ref` (optional): explicit -> message/review context -> default `browser-tester`
- `browser_tester_workspace` (optional): explicit -> message/review context -> current workspace
- `round`: explicit -> message body `Round` header -> default `1`

For non-browser inputs:
- `review_lane`: explicit -> message body -> `task` for an active delegated task -> `standalone`
- `planner_session_id`: `task` / `integration_final` -> explicit -> message body -> ask; `standalone` -> omit
- `planner_workspace`: `task` / `integration_final` -> explicit -> message body `Planner workspace` -> ask; `standalone` -> omit
- `requester_role`: explicit -> review lane (`coder` for task, otherwise requester) -> current context
- `requester_session_id`: explicit -> message body `Requester session` -> current review context -> ask
- `setup_contact_workspace` (browser): task -> Worker workspace; `integration_final` -> Planner workspace; standalone -> current workspace
- `workspace_handoff`: task -> explicit/message body complete -> preserve; missing/partial -> completeness FAIL; `integration_final` / `standalone` -> omit
- `start_branch`, `integration_branch`, `task_branch` (task only): explicit -> message body -> ask; otherwise omit
- `integration_branch`, `review_base` (`integration_final`): explicit -> message Scope target/base -> matching delta context -> ask; otherwise omit
- `workflow_policy`: delegated task -> task-scoped planner context; otherwise explicit -> message body -> matching delta context -> unattended defaults
- `special_requirements`: delegated task -> task-scoped planner context; otherwise explicit -> message body -> matching delta context -> omit
- `user_decisions` (optional): explicit -> message body -> matching delta context -> omit
- `checks_already_run` (optional): explicit -> message body -> matching delta context -> use for rerun decisions

Task branch-plan guard:
- `integration_branch` must be the non-task landing branch; if it looks like `task/*`, treat branch plan continuity as FAIL and ask for the real integration branch before approval/closeout
- delegated task Branch Plan must match planner context. On a requested change, stop review and return it to planner for a new dispatch context

Important identity clarification:
- `task` / `integration_final` require planner metadata; `standalone` requires only requester identity

Default policy when missing:
- `mode = "unattended"`
- `auto_accept_if_no_must_fix = true`
- `ui_manual_confirmation = "skip"`
- `review_round_convergence_check_threshold = 3`
- `review_round_hard_stop_threshold = 5`

## Continue

Retrieve `agentgear skill get review-code/continue-3` before proceeding.
