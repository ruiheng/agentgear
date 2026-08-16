---
skill-selector: message-rejected
selector-summary: Handle rejection of a previously sent message without creating a reply loop.
selector-aliases: action:message_rejected
---

# Message Rejected

- Use only `Original Delivery` to recover one exact outbound delivery from sent
  history. Require the actual `sender_address` to equal that delivery's
  recorded recipient and the current recipient to equal its recorded sender.
  Missing or ambiguous history is deferred. A route mismatch is failed without
  reading Error, resending, or acknowledging the rejection.
- After that gate passes, treat this as a routing failure for your own outbound delivery.
- Do not reply to the rejection.
- Use `Original Delivery` and `Error` to identify the send.
- If its complete original body and intended route are known, have not already been corrected, and the correction is unambiguous, correct and resend it once; otherwise report the blocker.
- Acknowledge the rejection after the resend or report.
