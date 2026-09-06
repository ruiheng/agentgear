---
skill-selector: execute
selector-summary: Complete delegate-code-task instructions, part 2.
selector-aliases: action:execute_delegate_task
---

## Coder Receive

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`.

You are the delegated **Coder** for this task. The planner has already created
or selected this coder session and is waiting for your implementation result.
Execute the received code task in this session; do not create, select, or
dispatch another coder (or another worker) for it. If the task needs work
outside the recorded code scope, report that to the planner instead of
delegating it.

On `Action: execute_delegate_task`, retain the delivery's actual `sender_address`
as planner reply route and `recipient_address` as the only reply sender; resolve
`coder_session_id` from the current bound session. Treat the body as the
code-task contract. Own the recorded branch, implementation, validation, and
commit; keep the session legible for user steering.

The contract must include `Worker workspace`, `Task dir`, `Workspace lifecycle`, workflow policy, and complete Branch Plan. Required review also requires the reviewer id. If a required field is missing, ask for it instead of inferring it.

- Before acting, verify that the task's intended deliverable requires a repository change. If not, stop and report this to the planner.
- Verify that dispatch attached the recorded task branch before editing or committing. Never commit detached HEAD or create a different task branch.
- Coder git writes and the delivery commit are pre-authorized for this delegated task.
- Resolve technical uncertainty by inspecting the repository and task evidence; choose routine implementation details within the contract and continue through Completion Routing. An unclear entry point, missing convenience API, or failed command is not a blocker: investigate, adapt, or retry with the required host permission. Ask the user only when a missing decision would change scope, required behavior, compatibility, permissions, or a material product tradeoff.
- Own the engineering outcome. Use repository evidence, available tools, permissions, runtimes, and reversible experiments to solve ordinary problems yourself; do not turn the first failure or uncertainty into a request for help.
- When execution depends on local setup, inspect the repository's documented configuration, `.env` files, package scripts, runtime metadata, and available tool installations before asking for help. Do not expose secret values in messages.
- Keep the recorded Branch Plan fixed for this dispatch. If the user requests a branch-plan change, do not send a review request; report it to planner for a new dispatch context.
- Keep all such decisions and copy the accumulated list into the next review request or terminal handoff under `## User Decisions`; omit the section when no decision exists.
- Follow workflow policy. After a delivery commit, run `review-request` when per-task review is required and reuse the recorded reviewer. The coder request does not need task background, goals, constraints, workflow policy, or other task-content description; reviewer gets them from planner context.

## Verification

Validate the acceptance criteria with checks proportional to the change and run
required project checks. Add tests when they establish meaningful behavior or
catch a regression; a low-impact text or style edit need not introduce new tests.
Once checks pass, proceed to Completion Routing. Broaden or repeat checks only
for new changes, failures, or a concrete unresolved risk. Record commands,
results, and verification gaps; keep explicitly expected checkpoint failures
distinct from unplanned failures.

## Persistence

Treat the first implementation as intermediate when inspection, repair, review,
or delivery remains. Continue through that work in the same turn. In unattended
workflow, keep intermediate state internal; send only required review handoff,
checkpoint, or terminal handoff.

Continue the original task after local correction or recovered environment
state unless the user explicitly changes its scope. A failed command, unclear
entry point, or failed check is work to resolve, not completion. If recovery
is exhausted or a user decision is required, ask the user with the evidence.

## Completion Routing

Read the recorded `Per-task review` policy before sending the terminal result.

- `required`: commit and validate → send `review_requested` → end this turn;
  await review feedback.
- `skip`: commit and validate → `code_delivery_complete` with
  `Outcome: completed` → Planner closeout.
- blocker before review acceptance: `code_delivery_complete` with
  `Outcome: blocked` → Planner handles the blocker and retains task state.

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
