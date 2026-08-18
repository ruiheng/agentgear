---
skill-selector: continue-3
selector-summary: Complete review-code instructions, part 4.
---

Execution flow in multi-agent mode:

1. Produce the full review report in the format above. Preserve the supplied
   Branch Plan, Workspace Handoff, Final Review Scope, and known User Decisions.
2. Choose exactly one result:
   - `rework_required` when a must-fix, completeness failure, or required browser
     change remains. Send it according to the lane-aware routing rules below.
   - `work_accepted` when the reviewed implementation is acceptable and no
     further coder/reviewer iteration is required. Send it according to the
     lane-aware routing rules below; it does not require closeout.
   - `abort_iteration` when the current coder/reviewer iteration must stop
     without accepting the work, such as non-convergence, a hard stop, or an
     unresolved prerequisite. Send it according to the lane-aware routing rules
     below.
   - `browser_check_requested` when code review is acceptable so far but runtime
     browser evidence is still required. On `browser_check_report`, resume with
     the matched review frame and choose one of the three review results.
3. For `rework_required`, send the full report to the recorded requester
   endpoint from `review_requested` with subject
   `rework required: <task_id> r<round>`. The requester may be the Coder or
   the Planner; do not assume a separate Coder exists.
4. For `work_accepted` or `abort_iteration`, send the full report with subject
   `review result: <task_id> r<round>` to the recorded Planner endpoint for
   `task` and `integration_final` lanes. For `standalone`, where no Planner
   exists, send it to the recorded requester endpoint instead.
5. The reviewer does not run `review-closeout`, merge branches, clean up
   sessions, or decide whether the planner should dispatch another agent.
   After delivering the result successfully, settle the claimed review input.

Waypost message rules:

- Keep the exact result Action in the full report body.
- Reviewer-originated actions use `from_session_id = reviewer_session_id`.
- `rework_required` targets the recorded requester endpoint for every lane.
- `work_accepted` and `abort_iteration` target the recorded Planner endpoint
  for `task` / `integration_final`, and the recorded requester endpoint for
  `standalone`.
- ACK a claimed review input only after the result message is delivered.
- Preserve `workflow_policy` and `special_requirements` unchanged.
- Keep transport JSON and raw addresses internal.

`work_accepted` means the reviewer accepts the implementation. `abort_iteration`
means only that this implementation/review iteration must stop; neither result
dictates closeout. The planner may close out, request another reviewer, ask for
browser validation, request a user decision, or take another workflow action.

Do not naturally end before the required result delivery succeeds. If a manual
user decision is required, present it and wait; do not turn it into a new
reviewer-specific iteration action.
