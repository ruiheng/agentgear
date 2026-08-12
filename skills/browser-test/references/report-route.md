---
skill-selector: report-route
selector-summary: Route a browser check report using its received workflow context.
selector-aliases: check-waypost-messages/action:browser_check_report
---

# Browser Check Report Route

Use the received report and `Browser Check` to choose one route. This is a declared discriminator route.

1. Require `Browser Check`. Missing or ambiguous correlation is a Receiver Contract blocker; never infer a target from Task or Round.
2. Recover the matching sent check from active context or check history.
3. If that frame is review-driven, the requester is the active reviewer. Retrieve and follow:

   `agentgear skill get review-code review continue-1 continue-2 continue-3`

   Pass the report plus the matching review frame. The review contract owns review-lane routing and settlement.
4. Otherwise, treat the received `To` requester as the direct requester. Require that requester at the frame's recorded requester workspace, deliver the report to that returned address if this route owns onward delivery, then acknowledge the claim. Do not retrieve the tester-side `browser-test check-request` contract and do not default a reviewer.

Keep the original requester as setup contact only; browser reports always follow the matching check's requester route.
