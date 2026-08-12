---
skill-selector: continue-1
selector-summary: Complete dispatch-plan instructions, part 2.
---

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
10. if this dispatch allocates a new planner lane, call `session_create` for `<planner_session_ref>` with the selected opaque launch candidate, the recorded supervisor parent real id, and `<planner_workspace>`. It verifies the parent; do not preflight it with `session_require`.
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
