---
skill-selector: run
selector-summary: Complete planner-closeout instructions, part 1.
selector-aliases: planner-closeout/start, action:closeout_delivered, action:code_delivery_complete
---

# Planner Closeout

Handle accepted-review `closeout_delivered` or coder `code_delivery_complete`.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Input

Provide the body from `closeout_delivered` or `code_delivery_complete`.
Use this skill only after that terminal handoff is received, or after the Planner produces the `closeout_delivered` body locally through `review-closeout` in the same turn.

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/diagnostics` for shared protocol:
- `Multi-Agent Mode Detection`
- `Context Resolution Priority`
- `Error Handling and Diagnostics`

Skill-specific context resolution:
- `task_id`: explicit -> message body -> ask
- `planner_session_id`: explicit -> message body `To` / `Planner` header -> current session id -> ask
- `worker_workspace`, `planner_workspace`, `task_dir`, `workspace_lifecycle` (completed workspace-closeout): message body -> ask
- `reviewer_session_id` (review-backed closeout only): explicit -> message body `Accepted Review By` header -> omit
- `coder_session_id`: completed code delivery -> explicit -> message body `From: coder` -> ask; review-backed closeout -> explicit -> optional `Coder session` header -> omit
- `session_host`: explicit -> message body `Session host` -> ask
- `start_branch`, `integration_branch`, `task_branch` (workspace-closeout only): explicit -> message body -> ask
- blocked `code_delivery_complete`: require task/planner identity; use other supplied fields only
- `delivery_id` (optional): explicit leased delivery context -> omit when unavailable
- `lease_token` (optional): explicit leased delivery context -> omit when unavailable

Action and Handoff gate:
- `closeout_delivered` / completed `code_delivery_complete`: require a complete Handoff and recorded branch plan
- completed `code_delivery_complete` requires `Per-task review: skip`; blocked accepts `required | skip` and needs no Handoff
- for workspace-closeout delivery, reject a missing or partial Handoff; do not recover or downgrade it

Branch-plan rule with a Handoff:
- `integration_branch` is the existing non-task branch that receives the completed task; `task_branch` is the completed task line named by the recorded plan
- use the recorded branch plan from the terminal handoff unchanged
- do not infer, rename, or repair branch plan during planner closeout
- if recorded `integration_branch` looks like `task/*`, stop and ask for the real integration branch before running closeout
- if any required branch-plan or workspace-handoff field is missing, ask one short clarification question instead of guessing

## Execution Flow

1. parse `Action:` and `Outcome` for code delivery before applying Handoff gates
2. for `closeout_delivered`, inspect `Residual Follow-up For Planner` and `UI Manual Confirmation Package`; for `code_delivery_complete`, inspect `Outcome` and `Checks`
3. for a completed workspace-closeout delivery, run the planner closeout batch with the recorded branch plan; for a blocked code delivery, retain workspace/lock state, report the blocker, and ack the claimed delivery without batch closeout
4. if this turn started from a claimed completed workspace-closeout delivery, pass `--ack-delivery-id` and `--ack-lease-token`; the batch ACK covers delivery merge/progress, not post-closeout cleanup
5. attempt recorded temporary-worktree cleanup after batch; report its status without reopening delivery
6. report task-session cleanup from the batch state; Agentgear removes verified disposable Agent Deck sessions and soft-deletes verified Thurbox sessions, while unsupported hosts or failed guards preserve and report them
7. report the result after planner closeout finishes

Required closeout command shape:

```bash
agentgear run multi-agent-protocol planner-closeout-batch.mjs \
  --task-id <task_id> \
  --task-branch <task_branch> \
  --integration-branch <integration_branch> \
  --worker-workspace <worker_workspace> \
  --planner-workspace <planner_workspace> \
  --task-dir <task_dir> \
  --planner-session-id <planner_session_id> \
  --session-host <session_host>
```

Optional command additions:
- add `--coder-session-id <coder_session_id>` for completed `code_delivery_complete`, and for review-backed closeout only when its optional coder id is present
- add `--reviewer-session-id <reviewer_session_id>` for `closeout_delivered`; omit it for `code_delivery_complete`
- add `--ack-delivery-id <delivery_id> --ack-lease-token <lease_token>` when handling a claimed workspace-closeout delivery
- add `--override-planner-workspace` only after explicit user confirmation to replace the mirrored `planner-workspace.json` records

## Continue

Retrieve `agentgear skill get planner-closeout/continue-1` before proceeding.
