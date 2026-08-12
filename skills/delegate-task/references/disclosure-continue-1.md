---
skill-selector: execute
selector-summary: Complete delegate-task instructions, part 2.
selector-aliases: check-waypost-messages/action:execute_delegated_task
---

## Context
- Parent goal: [only if it affects local choices]
- Must preserve: [upstream invariant]
- Established facts: [facts the worker can rely on]
- Known files: [already-known relevant paths; mark required reading; omit when absent]
- Other known context: [refs, excerpts, and facts; omit when absent]

## Boundaries
- [fixed decision or hard constraint]
- Watch for: [material risk]

## Done When
- [testable outcome]
- Report: [result, evidence, and open items; artifact locations as full paths or URIs]

## Special Requirements
[verbatim; only when present]
```

Waypost envelope:

```markdown
Task: <task_id>
Action: execute_delegated_task
From: <requester_role> <requester_session_id>
To: worker {{TO_SESSION_ID}}
Task kind: generic
Round: 1

<task contract>
```

## Dispatch

- Apply the Code Gate.
- require `source_material` when execution depends on requester-only material
- if `execution_skill = explain-for-me`, require `shared; cleanup=none`; do not dispatch a temporary worker

1. Resolve the worker by real id or ref with `session_resolve`.

2. For a direct session:

   - require `shared; cleanup=none`; a temporary lifecycle must use a Waypost worker
   - found: call `session_require` with its returned host, real id, and workspace; report its returned address for the user to continue
   - absent: stop and ask the user to create the direct session manually. Do not create a parentless generic session or inject a startup instruction.

3. For a Waypost worker:

   - found: call `session_require` with its returned host, real id, and workspace
   - absent: resolve role `<worker_tool_role>`, then call `session_create` with the selected opaque launch candidate and `parent_session_id = <requester_session_id>`; it verifies the requester parent, so do not preflight that parent with `session_require`
   - record the returned real id and sole address; fill `{{TO_SESSION_ID}}`, then call `waypost_send` from `waypost_status.default_sender` to that address, subject `delegate: <task_id> -> worker`
   - follow the shared Async sender rule

Until completion or explicit transfer, do not alter a worker-owned shared workspace; temporary cleanup is best-effort after terminal delivery.

## Worker Receive

On `Action: execute_delegated_task`:

- treat the body as the task contract and own local execution within it
- this action excludes repository/code-delivery mutation. If required, return it for `delegate-code-task`; do not edit code or Git delivery state under this contract
- follow user steering within scope; report a material scope conflict to the requester
- preserve the recorded workspace lifecycle in the terminal result
- for a temporary workspace, also preserve its cleanup owner and workspace
- when complete or blocked, send this result through Waypost:

```markdown
Task: <task_id>
Action: delegated_task_result
From: worker <worker_session_id>
To: <requester_role> <requester_session_id>
Worker workspace: <worker_workspace>
Workspace lifecycle: <workspace_lifecycle>
Cleanup owner: <requester; temporary only>
Cleanup workspace: <cleanup_workspace; temporary only>
Round: final

## Outcome
[completed | blocked summary]

## Evidence
- [result, checks, or artifact pointers]

## Open Items
- [item or `None`]
```

- Call `waypost_send` from the current `waypost_status.default_sender` to the recorded requester address, subject `delegated task result: <task_id>`; ack the claimed input only after it succeeds. On failure, do not ack; settle it under the shared Receiver Contract.

For direct user-owned code sessions only:

- user owns branch, commit, review, merge, and closeout decisions
- on a user review request, run `review-request` with `review_lane = standalone`; return it here without closeout
- make code progress and blockers legible, but do not claim workflow delivery or invent a Waypost result

## Requester Receive

On `delegated_task_result`, treat it as the worker's terminal update and continue requester-owned work. Do not infer a code, review, commit, or closeout workflow.

- For `temporary; cleanup=requester`, record and ACK the terminal result, then remove the listed non-primary worktree only when no workflow work remains. Generic workflow code does not remove or rehome host sessions. Report `cleanup=complete` on success; on failure retain it and report `cleanup=pending`. Do not delay or reopen delivery.

## User-Facing Result

For initial dispatch, return only:

- delegated objective and persistent-session reason
- worker session id, title, and workspace
- temporary-workspace cleanup status, when applicable
- any blocker or send failure

For a terminal worker result, return only its concise outcome, full artifact path/URI when present, and material open item or blocker.

Keep tool commands, addresses, raw JSON, and routine wakeup details internal.
