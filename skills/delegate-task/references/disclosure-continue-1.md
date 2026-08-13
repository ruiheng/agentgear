---
skill-selector: execute
selector-summary: Complete delegate-task instructions, part 2.
selector-aliases: action:execute_delegated_task
---

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
