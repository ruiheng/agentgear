---
skill-selector: start
selector-summary: Complete review-request instructions, part 1.
---

# Review Request

Generate a copy/paste-friendly Waypost message for code review.

Workflow protocol baseline: use the `multi-agent-protocol` skill.

## Required Scope Selection

Before generating the message, determine one scope:
1. `uncommitted changes`
2. `specific short commit ref`
3. `branch`

`integration_final`: `branch` only; require explicit `base_branch` distinct from target. Reject `commit` / `uncommitted`; do not convert or send.

Workflow continuity rule:
- In an ongoing implementation session, if scope is not explicit, inherit from active delegated task for current `task_id`
- Ask a clarification question only when multiple scopes are equally plausible or no reliable scope can be inferred

For a task review with a complete Workspace Handoff:
- preserve recorded `start_branch`, `integration_branch`, and `task_branch` from delegated task context
- keep that Branch Plan fixed for the dispatch
- if the user requests a Branch Plan change, stop before review and return it to planner for a new dispatch context

## Inputs

- Scope type: `uncommitted` | `commit` | `branch`
- Scope value:
  - `uncommitted`: no value
  - `commit`: short commit ref
  - `branch`: branch name
- Optional:
  - `base_branch` (branch or short commit ref, for branch scope)
  - `original_task`
  - `requester_role`
  - `requester_session_id`
  - `reviewer_session_ref`
  - `reviewer_session_id`
  - `session_host` (task lane; recorded host returned for the task sessions)
  - `review_lane`: `task` | `integration_final` | `standalone`
  - `review_focus` (explicit optional emphasis; do not infer)
  - `author_intent`
  - `author_noted_issues`
  - `user_decisions` (all prior task-scope decisions made by the user)
  - `coder_tool`
  - `coder_tool_profile`
  - `reviewer_tool`
  - `reviewer_tool_profile`
  - `start_branch`
  - `integration_branch`
  - `task_branch`
  - complete `Workspace Handoff`: `worker_workspace`, `task_dir`, `workspace_lifecycle`

## Task Authority (Required)

For a delegated task requested by coder:
- require the pre-created reviewer real id
- reviewer obtains original task, Special Requirements, and workflow policy from its planner-supplied task context
- `review_requested` does not need task background, goals, constraints, workflow policy, or other task-content description

For planner-owned task, `integration_final`, or `standalone`, populate `## Original Task` by priority:
1. explicit `original_task`
2. current requester task context
3. ask one short clarification question

## Data Collection (Read-Only)

Use read-only git commands only.

- Uncommitted:
  - `git status --short`
  - `git diff --name-status`
  - `git diff --cached --name-status`
  - `git ls-files --others --exclude-standard`
- Commit:
  - `git show --name-status --format=fuller <short-commit-ref>`
- Branch:
  - `integration_final`: require explicit `base_branch`, distinct from target; never fall back to `integration_branch`
  - otherwise choose base: `base_branch` -> recorded `integration_branch` -> ask
  - `git log --oneline <base>..<branch>`
  - `git diff --name-status <base>...<branch>`

## Scope Hygiene and Noise Control (Required)

Classify changes into:
- in-scope: directly related to original task
- noise/out-of-scope: unrelated local files, temporary artifacts, env files

Rules:
1. `Changed Paths Summary` includes in-scope files only
2. summarize unrelated noise with count + up to 3 examples
3. for committed scope, omit unrelated noise unless it materially affects review framing
4. if a material change is outside the original task and no User Decision covers it, ask the user before sending; never hide it as noise
5. ask one short clarification question if relevance is uncertain

## Review Independence

For delegated coder review, provide implementation scope, verification evidence, User Decisions, and routing continuity; task intent and constraints come from the planner context. For other lanes, provide task intent, scope, constraints, and verification evidence. Do not pre-review the change.
- Treat `Author Intent`, `Optional Review Focus`, and `Author-Noted Issues or Limitations` as non-authoritative and non-exhaustive context.
- Let the reviewer inspect the full scope and choose risk angles independently.
- Omit optional focus and author notes when the original task plus git target are enough.

## Continue

Retrieve `agentgear skill get review-request continue-1` before proceeding.
