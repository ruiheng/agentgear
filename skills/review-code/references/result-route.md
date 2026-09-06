---
skill-selector: result-route
selector-summary: Route a review result by its acceptance lane and plan context.
selector-aliases: action:rework_required, action:abort_iteration, action:work_accepted
---

# Review Result Route

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol` for sender
validation and routing recovery. Match Action, Task, Review lane, and Round to
the active review before acting.

After that gate passes, route `rework_required` to the recorded requester for
every lane. Route `abort_iteration` and `work_accepted` to the recorded Planner
for `task` / `integration_final`, or to the recorded requester for
`standalone`. The planner decides whether to close out, request another review,
or take another workflow action. The reviewer never runs closeout as part of reporting its
verdict. This is a declared discriminator route; retrieve the complete review
contract in order:

`agentgear skill get review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3`
