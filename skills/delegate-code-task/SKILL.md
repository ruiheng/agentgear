---
name: delegate-code-task
description: Delegate persistent code work to a coder.
---

# Delegate Code Task

Use `multi-agent-protocol` for shared transport, lifecycle, and tool resolution.
Use `delegate-task` in Selection-Only Use first when another action owns surface selection. A direct Code Gate transfer may enter here without generic dispatch. This skill owns the workflow code lane; do not dispatch a generic worker first.

## Code Scope

- Use this only for the workflow-owned Waypost code lane. Local, harness-subagent, and explicit user-owned direct work retain their own lifecycle.
- Keep code tasks serial. Decompose locally; ask only if splitting changes scope, priority, or tradeoffs.

## Brief Quality

Delegate the outcome, not a solution recipe.

- Give the coder only decision-relevant context: parent goal when it affects local choices, hard boundaries, established evidence, non-obvious fixed decisions with source, and testable acceptance criteria.
- Let the coder investigate, decompose, choose the implementation, and validate it.
- Optimize for the smallest conflict surface that still completes the task; exclude unrelated refactors, renames, moves, and cleanup.
- List only required reading and useful references. Omit empty optional sections rather than inventing context. Do not pin a commit unless an exact historical snapshot is explicitly required.
- Treat an unusually long brief as a framing smell. Remove detail that does not change the outcome, boundary, risk, or acceptance criteria.

## Workflow Context

Use the shared context priority. Resolve before dispatch:

- `task_id`: explicit -> context -> generate `YYYYMMDD-HHMM-<slug>`
- `planner_session_id`: explicit -> context -> bound Waypost sender -> ask
- `planner_workspace`: explicit -> workflow context -> current workspace -> ask
- `worker_workspace`: explicit -> workflow context -> `planner_workspace`
  - do not invent a separate workspace
  - from `execute-plan`, keep `worker_workspace = planner_workspace`
- `task_dir`: explicit -> workflow context -> `worker_workspace`
  - for `temporary; cleanup=planner`, it must resolve to the same path as `worker_workspace`; stop on mismatch
- `workspace_lifecycle`: explicit -> `shared; cleanup=none`
  - a temporary worktree needs explicit user confirmation and `temporary; cleanup=planner`
- `session_reason`: explicit -> infer one concrete persistence, control, or user-interaction reason -> ask
- branch plan:
  - `integration_branch`: the existing non-task landing branch; never `task/*`
  - `start_branch`: explicit/context; ask when the starting line is unclear
  - `task_branch`: reuse `start_branch` only when it is an explicitly recorded unfinished task branch; otherwise `task/<task_id>` from `integration_branch`
  - normal merge flow requires `task_branch != integration_branch`; never guess through ambiguity
- `coder_session_ref`: `coder-<task_id>`
- `session_host`: returned by `session_require` / `session_create`; preserve it through terminal closeout
- reviewer routing:
  - `reviewer_session_ref`: explicit -> workflow context -> `reviewer-<task_id>`
  - `reviewer_session_id`: explicit actual id -> workflow context -> create before coder dispatch when review is required
  - tool selection: explicit full command or profile -> workflow context -> shared role `reviewer` only when creating
- review policy: `per_task_review = required`, `final_review = skip` unless explicitly changed
- workflow policy: unattended with automatic acceptance when no must-fix finding; use a human gate only when explicitly requested
- `special_requirements`: explicit -> delegated context; preserve verbatim; omit when absent

Resolve a launch candidate only when creating a session:

- coder: explicit full command -> intended current-tool continuity -> shared role `coder`
- reviewer when review is required: explicit full command -> shared role `reviewer`
- preserve existing session launch metadata
- create or require the task reviewer before coder dispatch, under the same planner parent, workspace, and session host

## Canonical Task Brief

Write one canonical brief under `.agent-artifacts/message/`. The wrapper embeds it unchanged as the Task Contract in both reviewer and coder messages. Omit empty optional sections and lines rather than filling them with `None`; keep transport and role instructions outside the brief.

```markdown
## Task
[One sentence]

## Context
- Parent goal: [only if it affects local choices]
- Must preserve: [upstream invariant]
- Established facts: [facts the coder can rely on]
- Read first: [required repository paths]
- Optional references: [useful supporting paths]

## Boundaries
- [fixed decision or hard constraint]
- Watch for: [material risk]

## Acceptance Criteria
- [testable outcome]

## Special Requirements
[verbatim; only when present]
```

## Dispatch

For `temporary; cleanup=planner`, require `task_dir` and `worker_workspace` to resolve to the same path before dispatch.

1. Prepare workspace records:

   ```bash
   agentgear run multi-agent-protocol prepare-workspaces.mjs \
     --worker-workspace "<worker_workspace>" \
     --planner-workspace "<planner_workspace>" \
     --integration-branch "<integration_branch>" \
     --planner-session-id "<planner_session_id>"
   ```

   Stop on workspace or integration-branch mismatch. Use `--override-workspaces` only after explicit user confirmation.

2. Resolve the coder id/ref through the shared session-host contract. When review is required, also resolve or create the reviewer before coder dispatch with the same planner parent, workspace, and session host.

   - reuse a found coder with `session_require` and its returned host, real id,
     path, and address;
   - otherwise resolve role `coder`, then create `<coder_session_ref>` with
     its selected opaque launch candidate and recorded planner parent.
     `session_create` verifies that parent; do not preflight it with
     `session_require`.

   Record each returned host, real id, and sole address. Required review must
   have a real reviewer id and address before the wrapper runs.

3. Send the canonical brief through the lock-owning wrapper. It publishes the planner task contract to reviewer first, then dispatches coder only after reviewer delivery returns an id:

   ```bash
   agentgear run multi-agent-protocol send-delegate-with-active-task-lock.mjs \
     --workdir "<worker_workspace>" \
     --task-id "<task_id>" \
     --start-branch "<start_branch>" \
     --integration-branch "<integration_branch>" \
     --task-branch "<task_branch>" \
     --planner-session-id "<planner_session_id>" \
     --coder-session-id "<coder_session_id>" \
     --coder-session-ref "<coder_session_ref>" \
     --session-host "<session_host>" \
     --planner-workspace "<planner_workspace>" \
     --worker-workspace "<worker_workspace>" \
     --task-dir "<task_dir>" \
     --workspace-lifecycle "<workspace_lifecycle>" \
     --session-reason "<session_reason>" \
     --from-address "<waypost_status.default_sender>" \
     --to-address "<coder returned address>" \
     --subject "delegate code: <task_id> -> coder" \
     --brief-file "<brief_file>" \
     --review-context "required" \
     --workflow-policy "<resolved_policy>" \
     --reviewer-session-id "<reviewer_session_id>" \
     --reviewer-session-ref "<reviewer_session_ref>" \
     --reviewer-to-address "<reviewer returned address>" \
     --reviewer-subject "task context: <task_id> -> reviewer"
   ```

   For skipped review, set `--review-context "skip"` and omit the four
   `--reviewer-*` options.

   Run this wrapper with host permission. Report success only with a delivery
   id and a `sent` lock. Required review succeeds only with reviewer-context
   and coder delivery ids.

The wrapper owns active-task lock acquisition, reviewer-first ordering, and both sends. Do not split or duplicate those operations. If reviewer delivery succeeds but coder delivery fails, or either delivery is unknown, it retains the lock with the partial result. Surface that state; do not retry automatically.

After dispatch:

- follow the shared Async sender rule
- treat the worker worktree as coder-owned until closeout, even when planner and worker paths are equal
- successful planner closeout removes this task-scoped coder when the host cleanup adapter verifies it as disposable; explicitly reusable or guard-blocked sessions are preserved and reported
- keep any reviewer under the planner parent and in the same worker workspace
- planner attempts recorded temporary-worktree cleanup after closeout and reports `cleanup=complete` or `cleanup=pending`; neither changes delivery completion

## Coder Receive

On `Action: execute_delegate_task`, treat the body as the code-task contract. Own the recorded branch, implementation, validation, and commit; keep the session legible for user steering.

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
From: coder <coder_session_id>
To: planner <planner_session_id>
Planner: <planner_session_id>
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

- Omit `## User Decisions` when no temporary scope decision exists.
- For `Outcome: completed`, send only when review is skipped. For `Outcome: blocked`, send under either policy; include any existing delivery commit. Send from the current `waypost_status.default_sender` to the recorded planner address with subject `code delivery complete: <task_id>`; ack the claimed instruction only after send succeeds. The planner reports the blocker or runs closeout; do not run `review-closeout` or claim an accepted review.

## User-Facing Result

Return only:

- delegated objective
- persistent-session reason
- task and integration branches
- coder session id
- reviewer session id when review is required
- temporary workspace and cleanup status, when applicable
- any blocker or send failure

Keep tool commands, addresses, raw JSON, and routine wakeup details internal. Use shared diagnostics internally; report only the concise failure cause.
