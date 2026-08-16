---
skill-selector: continue-3
selector-summary: Complete review-code instructions, part 4.
---

Execution flow in multi-agent mode:
1. Produce the full review report in the format above
   - for task, preserve supplied Branch Plan and Workspace Handoff unchanged
   - for `integration_final`, preserve Final Review Scope in every report
   - preserve known User Decisions; the final task `stop_recommended` report summarizes all of them under `### User Decision Summary`
2. Choose action:
   - `rework_required` if `NEEDS_REVISION`, must-fix exists, completeness FAIL, or a browser report says `Code changed: yes`, unless the non-convergence stop rule below applies
   - `browser_check_requested` if code review is acceptable so far but runtime browser evidence is still required
   - `stop_recommended` if no must-fix remains and browser validation is not required or already passed
   - if `round >= review_round_hard_stop_threshold` and similar issues are still recurring or progress is clearly non-converging, do not send another routine `rework_required`; present the situation to the user, then apply the Manual-decision rule
3. For `rework_required`, send the full review report back to the requester session from `review_requested`
   - requester may be `coder` or `planner`
4. For `browser_check_requested`, generate one opaque `browser_check_id`, pass it to `browser-test-request` with this reviewer as report requester, and retain it with the review frame; pass original `requester_role` / `requester_session_id` and `setup_contact_workspace` as Setup Contact; on `browser_check_report`, resume with its evidence and matched review frame
   - `Code changed: yes` is a must-fix delivery boundary: carry its branch/commit/files in `rework_required`, not acceptance. Requester must own, commit/verify, and resubmit the changed scope; do not closeout this round
5. For `stop_recommended`:
   - never accept or close out while a material scope decision is awaiting the user
   - for `integration_final` / `standalone`, after automatic or explicit acceptance, send the full `stop_recommended` report to requester; do not run `review-closeout`
   - for task with `auto_accept_if_no_must_fix=true`, proceed to `review-closeout`
   - if the same final no-must-fix task-lane report is delivered to requester in unattended flow, requester may run `review-closeout` from that report instead of treating it as another rework round
   - only when `auto_accept_if_no_must_fix=false`, present user decision summary, then apply the Manual-decision rule
   - after explicit acceptance in human-gated flow, run `review-closeout` for task, or send the non-task result to requester
   - request human UI confirmation before acceptance/closeout only when `ui_manual_confirmation=required`, or when `ui_manual_confirmation=auto` and explicit policy wants heuristic UI gating

Waypost Message subject (`rework_required`):
- `rework required: <task_id> r<round>`

Waypost Message body rules (`rework_required`):
- use the full review report above as the body
- set `Action: rework_required`
- use `waypost`
- send it with `waypost_send`
  - `from_address = <current bound reviewer Waypost address>`
  - `to_address = <received review-request sender_address>`
  - `subject = "rework required: <task_id> r<round>"`
  - `body = <full review report>`
- include enough evidence and fix guidance that the requester can continue from the message body alone

Waypost Message (`stop_recommended`, accepted non-task):
- use only for `integration_final` / `standalone` after automatic or explicit acceptance
- retain `Action: stop_recommended` and use the full review report as body
- use the `rework_required` target and send shape with subject `review complete: <task_id> r<round>`
- ACK a claimed review input only after this send succeeds

Waypost Message subject (`user_requested_iteration` after user chooses iterate):
- use only for `task`; `integration_final` / `standalone` use `rework_required`
- `iteration requested: <task_id> r<round>`

Waypost Message body rules (`user_requested_iteration`):
- use this minimal routing envelope and continuation body:

```markdown
Task: <task_id>
Action: user_requested_iteration
Reviewer session: <reviewer_session_id>
Review lane: task
Round: <round>

### User Decision
[the user's explicit decision]

### Required Follow-ups
- [required change]

### Prior Review Findings
[the findings the coder needs to continue]
```

- do not repeat Branch Plan or Workspace Handoff; the receiver recovers them from the matching sent `review_requested` and active-task record
- use `waypost`
- send it with `waypost_send`
  - `from_address = <current bound reviewer Waypost address>`
  - `to_address = <received review-request sender_address>`
  - `subject = "iteration requested: <task_id> r<round>"`
  - `body = <iteration message body>`

For a user-facing `stop_recommended`, include Review Decision, Key Findings Snapshot, Residual Risk, and Verification Summary. Add UI Confirmation Gate only when applicable; add Decision Needed only for a manual choice.

When `auto_accept_if_no_must_fix=true`, state `Auto-accepted by workflow policy`; do not ask for a decision.

Manual-decision rule: after presenting a decision to the user, end this turn. Do nothing until the user's next instruction.

Required interaction behavior:
- For `rework_required`, send automatically after the report is ready
- For accepted `integration_final` / `standalone` `stop_recommended`, send the full report to requester automatically
- For `stop_recommended` with manual decision, do that only when `auto_accept_if_no_must_fix=false`; after the user's decision, close out task or send the accepted non-task result when accepted; when the user chooses iterate, send `user_requested_iteration` for `task` and a full `rework_required` report containing the decision and required follow-ups for `integration_final` / `standalone`
- In unattended flow, accepted no-must-fix task-lane reports that land with reviewer or requester must be treated as `review-closeout` input, not as another rework cycle
- In unattended flow, accepted `integration_final` / `standalone` reports return directly to requester; do not route them into `review-closeout`
- Preserve `workflow_policy` unchanged in outbound messages
- Preserve `special_requirements` unchanged in outbound messages
- Keep message JSON internal unless user explicitly asks
- Do not naturally end after writing the review report; if this action requires `rework_required`, accepted non-task `stop_recommended`, task-only `user_requested_iteration`, or `review-closeout`, complete that workflow step before ending the turn

Sender identity rule:
- reviewer-originated actions (`rework_required`, `stop_recommended`, `user_requested_iteration`) use `from_session_id = reviewer_session_id`
- `closeout_delivered` uses the session id of the agent that executes `review-closeout`; preserve `reviewer_session_id` as the source of the accepted review
