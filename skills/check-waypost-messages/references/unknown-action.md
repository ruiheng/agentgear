---
skill-selector: unknown-action
selector-summary: Handle a syntactically valid but unsupported Action safely.
---

# Unknown Action

Do not guess a handler. Call `waypost_send` to send this body to the received `sender_address` with subject `message rejected: <delivery_id>`:

```markdown
Action: message_rejected
Original Delivery: <delivery_id>
Error: unknown_action
Received Action: <token>

Replace the Action with a registered token, or omit the Action field for an ordinary message.
```

Use the current `recipient_address` as sender. Never include the rejected body. If the send succeeds, acknowledge the rejected delivery. If the sender address is absent or the send fails, use the executable and state directory reported by `waypost_status` to run structured argv `[executable,"--state-dir",state_dir,"fail","--delivery",delivery_id,"--lease-token",lease_token,"--reason","unknown_action","--json"]`. Report its returned state; never release this delivery.
