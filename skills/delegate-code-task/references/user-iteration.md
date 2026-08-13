---
skill-selector: user-iteration
selector-summary: Continue a delegated code task after requester iteration.
selector-aliases: action:user_requested_iteration
---

# User Requested Iteration

On `user_requested_iteration`, treat the body as the recorded code-task continuation. Own the recorded branch, implementation, validation, and commit; keep the session legible for user steering.

- Keep the recorded Branch Plan fixed for this dispatch. If the user requests a branch-plan change, do not send a review request; report it to planner for a new dispatch context.
- Keep all user decisions and copy the accumulated list into the next review request or terminal handoff under `## User Decisions`; omit the section when no decision exists.
- Follow workflow policy. After a delivery commit, run `review-request` when per-task review is required and reuse the recorded reviewer. The coder request does not need task background, goals, constraints, workflow policy, or other task-content description; reviewer gets them from planner context.
- For a material scope change or uncertainty, ask the user immediately and wait before applying or committing it. A user instruction that resolves it is the decision.

Retrieve `agentgear skill get delegate-code-task/execute delegate-code-task/continue-2` only if the recorded coder contract is not already available.
