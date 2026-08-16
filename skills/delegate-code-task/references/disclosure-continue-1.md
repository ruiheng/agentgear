---
skill-selector: execute
selector-summary: Complete delegate-code-task instructions, part 2.
selector-aliases: action:execute_delegate_task
---

## Coder Receive

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`.

On `Action: execute_delegate_task`, retain the delivery's actual `sender_address`
as planner reply route and `recipient_address` as the only reply sender; resolve
`coder_session_id` from the current bound session. Treat the body as the
code-task contract. Own the recorded branch, implementation, validation, and
commit; keep the session legible for user steering.

The contract must include `Worker workspace`, `Task dir`, `Workspace lifecycle`, workflow policy, and complete Branch Plan. Required review also requires the reviewer id. If any required field is missing, report a blocker instead of inferring it.

- Attach the recorded task branch before editing or committing; create it from the recorded integration branch only when absent. Never commit detached HEAD.
- Coder git writes and the delivery commit are pre-authorized for this delegated task.
- If a material scope change or uncertainty appears, ask the user immediately and wait before applying or committing it. A user instruction that resolves it is the decision.
- Keep the recorded Branch Plan fixed for this dispatch. If the user requests a branch-plan change, do not send a review request; report it to planner for a new dispatch context.
- Keep all such decisions and copy the accumulated list into the next review request or terminal handoff under `## User Decisions`; omit the section when no decision exists.
- Follow workflow policy. After a delivery commit, run `review-request` when per-task review is required and reuse the recorded reviewer. The coder request does not need task background, goals, constraints, workflow policy, or other task-content description; reviewer gets them from planner context.
- Send this terminal handoff after commit and validation when review is skipped, or on a blocker before an accepted task review:

```markdown
Task: <task_id>
Action: code_delivery_complete
Planner: <planner_session_id>
Coder session: <coder_session_id>
Session host: <session_host>
Planner workspace: <planner_workspace>
Worker workspace: <worker_workspace>
Task dir: <task_dir>
Workspace lifecycle: <workspace_lifecycle>
Per-task review: <required | skip>
Delivery commit: <short_commit | `None` when blocked>
Round: final

## Branch Plan
- Start branch: <start_branch>
- Integration branch: <integration_branch>
- Task branch: <task_branch>

## User Decisions
[all temporary user scope decisions for this task; only when present]

## Outcome
[completed | blocked summary]

## Checks
- [command/result or `None`]
```

## Continue

Retrieve `agentgear skill get delegate-code-task/continue-2` before proceeding.
