---
skill-selector: start
selector-summary: Complete delegate-task instructions, part 1.
---

# Delegate Task

Use `agentgear skill get multi-agent-protocol start shared-protocol` for Waypost transport and lifecycle; retrieve `agentgear skill get multi-agent-protocol session-host tool-resolution` when session lifecycle work is needed.

Delegate one bounded outcome; do not run it locally or infer a code-delivery lifecycle.

## Code Gate

Classify before selecting a transport or dispatching.

- For named execution, classify from the skill contract; its side effects override task labels.
- `code-changing`: mutates repository code/config/schema/contracts or Git delivery state. Declared non-code artifacts remain generic. Unknown -> ask.
- Waypost code -> `delegate-code-task`. Direct code requires explicit `user-owned direct` and has no automatic delivery lifecycle; otherwise use the code lane or ask.

## Choose Execution Surface

Use the lightest delegated surface that preserves the task's lifecycle:

- During Selection-Only Use, record local execution when the owning action can perform it.
- Use a native harness subagent, when available, for short independent parallel work. It is disposable: the harness owns bounded execution and its result; the caller owns any code delivery. Do not create or address a persistent session for it.
- Use a persistent session host when work needs persistent history, explicit tool/workspace control, later Waypost coordination, or a user-visible session to inspect, steer, or resume.
- State one concrete lifecycle or user-interaction reason for a persistent session; difficulty or parallelism alone is insufficient.

For a named execution skill, use a persistent Waypost session when the requester has an address. Without a portable parent, ask the user to create a direct host session first, then resolve it. Use a native harness subagent only when the user explicitly requests disposable work.

## Selection-Only Use

When another action owns dispatch, use the selection rules above and stop before `Context` or `Dispatch`.

- Record the selected surface and, for a persistent session, its concrete `session_reason` for the owning action.
- If the owning action has a stricter direct-execution gate, use it only for that fast path. It may retain a planner-owned nonpersistent fallback without creating a worker.
- Do not resolve sessions, compose a task contract, create a worker, or send `execute_delegated_task`.
- Workflow-owned code -> `delegate-code-task`; record direct user-owned code as a separate surface.

## Scope and Brief

- Brief one outcome with decision-relevant context, boundaries, and completion criteria; let the worker investigate and validate.
- For a named skill, send exact input and only required known files/context. Attach requester-only source inline or by durable ref; do not search merely to enlarge context.
- Ask before splitting only when it changes scope, priority, or tradeoffs.

## Select Transport

- **Direct session:** no addressable requester session, or the user wants to work with the session directly. Generic creation has no portable parent, so require the user to create the host session and provide its id/ref. The user observes and steers it there; no automatic Waypost return is expected. Code is allowed only for explicit user-owned direct delivery.
- **Waypost worker:** an addressable requester session exists and later coordination or a returned result is needed. Send `execute_delegated_task`; the worker returns `delegated_task_result`. This is non-code only.

Do not invent a requester address. For a direct continuation, surface the existing session and let the user steer it there rather than injecting a second task from this session.

## Context

Use shared context priority; resolve only fields for the selected transport.

- `task_id`: explicit -> context -> `YYYYMMDD-HHMM-<slug>`
- `execution_skill`: explicit field -> first token of `$delegate-task` input when it is an exact installed skill (`$name` or `name`) -> omit
  - inspect only that token; reject `delegate-task` as its own inner skill
  - `$delegate-task $explain-for-me 中文` -> skill `explain-for-me`, input `中文`
- `execution_input`: explicit -> remainder after the inner skill; otherwise full `$delegate-task` input -> `N/A`
- `source_material`: explicit text/ref -> required requester-chat material -> omit when self-contained; use inline content or a durable worker-readable path
- `task_kind`: skill contract + explicit task/context -> `generic`; code/delivery side effects -> `code-changing`; unclear -> ask
- `worker_tool_role`: explicit -> `explainer` when `execution_skill = explain-for-me` -> `worker`
- Direct code only: `user_owned_code_delivery`: explicit user decision -> `true`; otherwise absent
- `worker_workspace`: explicit -> workflow/current workspace -> ask
  - do not invent a separate workspace
- `workspace_lifecycle`: require `shared; cleanup=none` for `explain-for-me`; otherwise explicit -> `shared; cleanup=none`
  - a temporary worktree is Waypost-only; require explicit user confirmation, `temporary; cleanup=requester`, and `cleanup_workspace`; requester owns closeout
- Waypost temporary only: `cleanup_workspace`: explicit -> requester workspace that owns the worktree -> ask
- `session_reason`: explicit -> infer one concrete reason -> ask
- `worker_session_ref`: explicit -> context -> `worker-<task_id>`
- `worker_session_id`: explicit real id -> workflow context -> omit
- Waypost only: `requester_session_id`: explicit -> live Waypost context -> ask; `requester_role`: explicit -> workflow role -> `requester`
- `special_requirements`: explicit -> delegated context; preserve verbatim; omit when absent

Resolve a launch candidate only when creating a worker: explicit full command -> intended current-tool continuity -> shared `<worker_tool_role>` role. Preserve an existing session's recorded launch metadata.

## Task Contract

Use this as the direct task contract. Prepend the Waypost envelope below for a Waypost worker. For a temporary worktree, include its cleanup owner and workspace.

```markdown
## Objective
[One sentence]

## Session Contract
- Why persistent session: <session_reason>
- Task kind: <generic | code-changing>
- Code delivery: <N/A | user-owned direct>
- Worker workspace: <worker_workspace>
- Workspace lifecycle: <shared; cleanup=none | temporary; cleanup=requester>
- Cleanup owner: <requester; temporary only>
- Cleanup workspace: <cleanup_workspace; temporary only>
- The user may inspect or steer this session; make material choices and blockers legible.

## Execution
- Skill: <$skill-name | N/A>
- Input: [verbatim skill input or `N/A`]
- Source: [inline material or durable worker-readable ref; omit when Input is self-contained]
- If Task kind is `generic` and Skill would change repository or code-delivery state, report a lane mismatch; do not run it.
- If Skill is not `N/A`, load and run it with Input plus this task contract. Missing skill -> report blocker.

## Continue

Retrieve `agentgear skill get delegate-task dispatch` before dispatching.
