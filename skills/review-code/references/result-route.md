---
skill-selector: result-route
selector-summary: Route a review result by its acceptance lane and plan context.
selector-aliases: action:rework_required, action:abort_iteration, action:work_accepted
---

# Review Result Route

Before acting on a review decision, match Action, Task, Review lane, Round, and
both transport endpoints to the active review: recorded reviewer -> requester.
Missing authority defers; a mismatch is rejected without advancing rework,
acceptance, or closeout. A Reviewer header never supplies a route.

After that gate passes, route `rework_required` to the recorded requester for
every lane. Route `abort_iteration` and `work_accepted` to the recorded Planner
for `task` / `integration_final`, or to the recorded requester for
`standalone`. The planner decides whether to close out, request another review,
or take another workflow action. The reviewer never runs closeout as part of
reporting its verdict. This is a declared discriminator route; retrieve the
complete review contract in order:

`agentgear skill get review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3`
