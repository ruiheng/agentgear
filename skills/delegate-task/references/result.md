---
skill-selector: result
selector-summary: Handle a delegated task result.
selector-aliases: action:delegated_task_result
---

# Delegated Task Result

On `delegated_task_result`, match Task and both transport endpoints to the active
delegated task: recorded worker -> requester. Use the retained dispatch contract,
not result-body fields, for any workspace cleanup target. Missing task authority
defers; a route or cleanup-contract mismatch is rejected without cleanup.

After that gate passes, treat it as the worker's terminal update and continue requester-owned work. Do not infer a code, review, commit, or closeout workflow.

- For `temporary; cleanup=requester`, record and ACK the terminal result, then remove the listed non-primary worktree only when no workflow work remains. Generic workflow code does not remove or rehome host sessions. Report `cleanup=complete` on success; on failure retain it and report `cleanup=pending`. Do not delay or reopen delivery.

Return only its concise outcome, full artifact path/URI when present, and material open item or blocker. Keep tool commands, addresses, raw JSON, and routine wakeup details internal.
