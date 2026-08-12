---
skill-selector: continue-1
selector-summary: Complete planner-closeout instructions, part 2.
---

## Rules

- this skill is the planner-side runtime handler for `closeout_delivered` and `code_delivery_complete`
- completed workspace terminal messages need a complete Handoff and Branch Plan; do not recover missing fields
- accept completed `code_delivery_complete` only with `Per-task review: skip`; accept blocked delivery under either policy. Do not route either through `review-closeout` or invent an accepted review
- run batch closeout for `code_delivery_complete` only when its `Outcome` is completed; a blocked outcome is a planner blocker, not a merge or cleanup request
- for a blocked code delivery, retain the active task, branch, workspace, and sessions; report the blocker and ack without requesting missing Handoff data
- use the terminal body as the primary planner handoff; reread the full review only when a review-backed handoff is insufficient
- coder/reviewer execution is asynchronous and may take unbounded time; this skill starts only after the closeout message actually arrives
- do not start planner closeout speculatively while coder or reviewer work is still in progress
- run the planner closeout script for `closeout_delivered` and completed `code_delivery_complete` only
- for `temporary; cleanup=planner`, require a complete Handoff, then require `task_dir` and `worker_workspace` to resolve to the same path before batch or cleanup; otherwise retain both paths and report the mismatch
- for `temporary; cleanup=planner`, after batch success, remove the listed non-primary worktree only when no workflow work remains. Report worktree cleanup separately as `complete` or `pending`; it does not replace task-session cleanup.
- task-session cleanup runs only after merge/progress and any requested delivery ACK succeed. It uses exact ids and host ownership guards. Unsupported or explicitly reusable sessions are preserved with an optional warning; guard or deletion failures also keep workspace records for retry.
- after planner closeout, later tasks in the same workflow must run workspace prepare again before their own closeout path
- do not dispatch another planner lane into the same workspace merely because the reservation record was released; let the supervisor/dispatcher schedule lanes
- if the shared workspace still shows active coder changes when closeout starts, stop and report the blocker instead of altering workspace state around those changes
- if planner closeout fails, report the blocker and the exact manual action from the script output
- keep message JSON internal unless the user explicitly asks
- do not end until batch succeeds or a concrete blocker is reported; report temporary cleanup as `complete` or `pending`

## User-Facing Output

After terminal handling:
- for workspace-closeout, report required-action result, recorded branch pair, ack state, task-session cleanup, worktree lifecycle/cleanup status, and any unblock step
- for a blocked code delivery, report the blocker, retained task state, and ack state; no merge or cleanup ran
