---
skill-selector: start
selector-summary: Complete delegate-code-task instructions, part 1.
---

# Delegate Code Task

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for shared transport and lifecycle; retrieve `agentgear skill get multi-agent-protocol/session-host multi-agent-protocol/tool-resolution` when session lifecycle work is needed.
Use `delegate-task` in Selection-Only Use first when another action owns surface selection. A direct Code Gate transfer may enter here without generic dispatch. This skill owns the workflow code lane; do not dispatch a generic worker first.

## Code Scope

- Use this only for the workflow-owned Waypost code lane. Local, harness-subagent, and explicit user-owned direct work retain their own lifecycle.
- Keep code tasks serial.

## Decomposition Gate

Before session, workspace, or brief work, decide whether the request is one independently reviewable task or an ordered task queue. Do not dispatch before making this decision.

- Split distinct testable outcomes or dependency boundaries, not files, layers, or implementation steps. For an approved plan item, only verify that it is cohesive.
- Each unit must have one outcome and testable acceptance criteria. Include prerequisites or boundaries only when relevant. Ask only when splitting changes scope, priority, or tradeoffs.
- Dispatch only the first ready unit and keep the queue serial. The planner owns cross-task decomposition; the coder owns implementation breakdown within that unit.

## Brief Quality

Delegate the outcome, not a solution recipe.

- Give the coder only decision-relevant context: parent goal when it affects local choices, hard boundaries, established evidence, non-obvious fixed decisions with source, and testable acceptance criteria.
- Let the coder investigate, decompose implementation within the selected task unit, choose the implementation, and validate it.
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
- resolve or allocate the coder and required reviewer before workspace preparation, under the same planner parent, worker workspace, and session host

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

## Continue

Retrieve `agentgear skill get delegate-code-task/dispatch` before dispatching.
