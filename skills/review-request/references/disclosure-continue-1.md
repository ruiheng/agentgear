---
skill-selector: continue-1
selector-summary: Complete review-request instructions, part 2.
---

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol shared-protocol session-host tool-resolution` for shared protocol.

Skill-specific context resolution:
- `task_id`: explicit -> branch `task/<task_id>` -> delegated context -> ask
- `review_lane`: explicit -> delegated context -> `task` for an active delegated task -> `standalone`
- `planner_session_id`: `task` / `integration_final` -> explicit/context -> ask; `standalone` -> omit
- `planner_workspace`: `task` / `integration_final` -> explicit -> delegated context -> current workspace when requester is planner -> ask; `standalone` -> omit
- `requester_role`: explicit -> delegated context -> current workflow role -> default `coder`
- `requester_session_id`: explicit -> current session id -> delegated context -> ask
- `reviewer_session_ref`: delegated task from coder -> recorded task reviewer ref; otherwise explicit -> context -> `reviewer-<review_lane>-<owner_session_id>-<task_id>`; owner is planner for `task` / `integration_final`, requester for `standalone`
- `reviewer_session_id`: delegated task from coder -> require recorded real id; otherwise explicit actual id -> context actual id -> created on demand when missing
- `session_host`: task -> explicit -> delegated task context -> returned requester host; other lanes -> omit
- `workflow_policy`: delegated task from coder -> omit from request; reviewer uses planner context. Other lanes: explicit -> context -> default unattended policy
- `special_requirements`: delegated task from coder -> planner context; do not include in coder request; other lanes -> explicit -> context -> omit
- `user_decisions` (optional): explicit -> delegated context -> omit
- `coder_tool_profile`: explicit -> delegated context -> omit when `coder_tool` is already a full command -> default current-tool continuity or resolver role default `coder`
- `coder_tool_cmd`: explicit full command -> delegated context resolved command -> current AI tool when continuity is intended -> `agentgear skill get multi-agent-protocol tool-resolution` for role `coder`
- `reviewer_tool_profile`: explicit -> delegated context -> omit when `reviewer_tool` is already a full command -> default resolver role default `reviewer`
- `reviewer_tool_cmd`: explicit full command -> delegated context resolved command -> `agentgear skill get multi-agent-protocol tool-resolution` for role `reviewer`
- `round`: explicit -> infer from context -> default `1`
- `workspace_handoff`: task -> explicit/delegated complete handoff -> preserve; missing/partial -> ask; `integration_final` / `standalone` -> omit
- `start_branch`, `integration_branch`, `task_branch` (task only): explicit -> delegated context -> ask; otherwise omit

Handoff gate:
- task: require complete Handoff and recorded Branch Plan
- `integration_final` / `standalone`: omit task Branch Plan and Handoff

Workspace-closeout branch-plan guard:
- `integration_branch` must be the non-task landing branch; if it looks like `task/*`, ask for the real integration branch instead of sending the review request

When this is a follow-up round after reviewer feedback, summarize which findings were adopted, which were rejected, and why.
Reviewer feedback is advisory input, not automatic instructions.

Review-request continuity rule:
- round `1` uses the full review-request body
- round `>1` to the same reviewer session uses a delta-only body
- if the reviewer session changed or reviewer continuity is unknown, fall back to the full review-request body
- a task review remains `task` through every round
- task repeats its complete Handoff and Branch Plan every round; a full request includes all User Decisions and a delta includes decisions made since the prior review
- delegated coder requests omit task content, Special Requirements, and workflow policy; reviewer already has planner context
- every delta retains `Task`, `Action`, `From`, `To`, `Round`, and Lane; task / `integration_final` also retain Planner fields
- delta-only means terse:
  - task-content description, file list, and unchanged verification do not need to be included; task always carries Branch Plan and Handoff
  - summarize only changed scope, responses to prior findings, and new verification evidence; let the reviewer decide what to re-check
  - one-line body applies only to delta content; task retains its required fields

Identity rules:
- `review_requested` sender must be the active requester session id for this review lane
- use the bound Waypost sender context for sender validation

Reviewer continuity:
- delegated task from coder: require the recorded reviewer identity in the recorded workspace and host; stop on missing or mismatch; never create a replacement reviewer
- other lanes: treat a known real `reviewer_session_id` as authoritative and reuse it with `session_require`; otherwise resolve `reviewer_session_ref` and create only when no real id resolves

Commit reference rule:
- in message content, use a short commit ref, not a full 40-char hash

## Output Template

Round `1` or new reviewer session: use the full body below. Delegated task review from coder omits `## Original Task`, `## Workflow Policy`, and `## Special Requirements`.
Omit `## User Decisions` when no temporary scope decision exists.

Use this structure as the message body. Omit task Branch Plan and Handoff for `integration_final` / `standalone`; task includes both. `standalone` also omits planner headers. Keep tool routing internal.

```markdown
Task: <task_id>
Action: review_requested
From: <requester_role> <requester_session_id>
To: reviewer {{TO_SESSION_ID}}
Round: <round>

## Summary
[One-line review request summary]

## Scope
- Type: [uncommitted | commit | branch]
- Target: [working tree | short commit ref | branch name]
- Base (branch): [base ref or N/A]

## Original Task
[Non-delegated review only: original task text from explicit input or requester context. Use `Not provided` only after explicit clarification that no task text is available.]

## User Decisions
[all user scope decisions known for this task; only when present]

## Review Context
- Lane: [task | integration_final | standalone]

## Optional Review Focus
- [Explicit optional emphasis; must not limit the full independent review]

## Author Intent (Optional)
[Brief non-authoritative intent note; do not restate the diff]

## Changed Paths Summary
- In-scope changed paths: [count + key paths, or `See scope target` when the git target is enough]
- Out-of-scope noise: [count + up to 3 examples, or `None`]

## Checks Already Run
- Lint: [command/result or `Not run`]
- Build/Link: [command/result or `Not run`]
- Compile/Type-check: [command/result or `Not run`]
- Tests: [command/result or `Not run`]
- Other verification: [manual/browser/scripted checks or `None`]
- Coverage gaps: [known missing tests or validation gaps; if none write: None identified]

## Workflow Policy
[resolved workflow policy]

## Special Requirements
[only when present]

## Continue

Retrieve `agentgear skill get review-request continue-2` before proceeding.
