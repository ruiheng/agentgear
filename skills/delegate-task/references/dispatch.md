---
skill-selector: dispatch
selector-summary: Dispatch a bounded non-code task to its selected worker.
---

Waypost envelope:

```markdown
Task: <task_id>
Action: execute_delegated_task
Task kind: generic
Round: 1

Apply the `route-waypost-action` skill.

<task contract>
```

## Dispatch

- Apply the Code Gate.
- require `source_material` when execution depends on requester-only material
- if `execution_skill = explain-for-me`, require `shared; cleanup=none`; do not dispatch a temporary worker

1. Call `session_require` for the worker id or ref, expected workspace, and
   known host. It returns `not_found` without creating a session.

2. For a direct session:

   - require `shared; cleanup=none`; a temporary lifecycle must use a Waypost worker
   - `ready`: report its returned real id and address for the user to continue
   - `not_found`: stop and ask the user to create the direct session manually. Do not create a parentless generic session or inject a startup instruction.

3. For a Waypost worker:

   - `ready`: reuse its returned host, real id, and address
   - `not_found`: resolve role `<worker_tool_role>`, then call `session_create` with the selected opaque launch candidate and `parent_session_id = <requester_session_id>`; it verifies the requester parent, so do not preflight that parent with `session_require`
   - record the returned real id and sole address, then call `waypost_send` from `waypost_status.default_sender` to that address, subject `delegate: <task_id> -> worker`
   - follow the shared Async sender rule

Until completion or explicit transfer, do not alter a worker-owned shared workspace; temporary cleanup is best-effort after terminal delivery.
