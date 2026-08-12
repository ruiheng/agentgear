---
skill-selector: result-route
selector-summary: Route a review result by its acceptance lane and plan context.
selector-aliases: check-waypost-messages/action:rework_required, check-waypost-messages/action:stop_recommended
---

# Review Result Route

Use the received lane and matching active plan context to select rework, requester handoff, or review closeout. This is a declared discriminator route; retrieve the complete review contract in order:

`agentgear skill get review-code review continue-1 continue-2 continue-3`
