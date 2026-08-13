---
skill-selector: message-rejected
selector-summary: Handle rejection of a previously sent message without creating a reply loop.
selector-aliases: action:message_rejected
---

# Message Rejected

- Treat this as a routing failure for your own outbound delivery.
- Do not reply to the rejection.
- Use `Original Delivery` and `Error` to identify the send.
- If its complete original body and intended route are known, have not already been corrected, and the correction is unambiguous, correct and resend it once; otherwise report the blocker.
- Acknowledge the rejection after the resend or report.
