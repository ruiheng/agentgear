---
skill-selector: task-context
selector-summary: Retain planner task context for a code review.
selector-aliases: check-waypost-messages/action:review_task_context
---

# Review Task Context

On delegated `review_task_context`:

- verify planner sender, task, reviewer identity, session host, Branch Plan, Workspace Handoff, Task Contract, and workflow policy;
- retain it as this task-scoped reviewer's planner context; keep transport metadata internal;
- acknowledge it and wait; do not inspect or judge code from this message alone.

On the later delegated `review_requested` from coder, recover the matching task-scoped planner context when it is not already active; require matching task, planner, reviewer, session host, Branch Plan, and Workspace Handoff. Use planner Task Contract, including Special Requirements, as original-task authority; apply later User Decisions as task-specific amendments. Use workflow policy only from planner context; coder requests do not repeat it. Treat coder-authored task prose, when present, as non-authoritative context; it does not replace missing planner context.

Missing or mismatched planner context is a completeness failure, not permission to infer. Retrieve `agentgear skill get review-code review continue-1 continue-2 continue-3` only when the complete review contract is required.
