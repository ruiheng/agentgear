---
skill-selector: result-route
selector-summary: Route a review result by its acceptance lane and plan context.
selector-aliases: action:rework_required, action:stop_recommended
---

# Review Result Route

Before acting on a review decision, match Action, Task, Review lane, Round, and
both transport endpoints to the active review: recorded reviewer -> requester.
Missing authority defers; a mismatch is rejected without advancing rework,
acceptance, or closeout. A Reviewer header never supplies a route.

After that gate passes, use the received lane and matching active plan context to select rework, requester handoff, or review closeout. This is a declared discriminator route; retrieve the complete review contract in order:

`agentgear skill get review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3`
