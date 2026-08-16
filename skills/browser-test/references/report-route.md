---
skill-selector: report-route
selector-summary: Route a browser check report using its received workflow context.
selector-aliases: action:browser_check_report
---

# Browser Check Report Route

Use the received report and `Browser Check` to choose one route. This is a declared discriminator route.

1. Require `Browser Check`. Missing or ambiguous correlation is a Receiver Contract blocker; never infer a target from Task or Round.
2. Recover the matching sent check from active context or check history.
3. Before reading browser evidence or Outcome, apply the shared Expected Sender
   Gate: require the actual `sender_address` to equal the authoritative browser
   tester address retained with that sent check and the actual
   `recipient_address` to equal that check's recorded requester address. Missing
   route authority is context loss; a mismatch is rejected without advancing
   review or direct acceptance. Tester identity in the body never supplies an
   expected route.
4. If that frame is review-driven, the requester is the active reviewer. Retrieve and follow:

   `agentgear skill get review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3`

   Pass the report plus the matching review frame. The review contract owns review-lane routing and settlement.
5. Otherwise, treat the authenticated recipient as the direct requester, continue from the report, and acknowledge the claim. Do not forward an already delivered report, retrieve the tester-side `browser-test check-request` contract, or default a reviewer.

Keep the original requester as setup contact only; browser reports always follow the matching check's requester route.
