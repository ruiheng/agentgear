---
skill-selector: message-rejected
selector-summary: Handle rejection of a previously sent workflow message without replying to the rejection.
selector-aliases: action:message_rejected
---

# Message Rejected

- Use `Original Delivery` to recover the exact outbound delivery from sent
  history. Require its recorded recipient to match the rejection sender and its
  recorded sender to match the current recipient.
- Missing or ambiguous history: defer the claim. Endpoint mismatch: fail it
  without reading `Error`, acting, or acknowledging.
- Treat a matching rejection as a failure of that outbound delivery. Do not
  reply to the rejection.
- Correct and resend once only when the complete original delivery and the
  correction are both unambiguous; otherwise report the blocker.
- Acknowledge a matching rejection after the resend or report.
