---
skill-selector: invalid-envelope
selector-summary: Handle a malformed claimed Waypost envelope safely.
---

# Invalid Envelope

Do not infer an Action. Call `waypost_send` to send this body to the received `sender_address` with subject `message rejected: <delivery_id>`:

```markdown
Action: message_rejected
Original Delivery: <delivery_id>
Error: malformed_action

Use no Action field for an ordinary message, or one exact registered `Action: <token>` field for an Agentgear workflow message.
```

Use the current `recipient_address` as sender. Never include the rejected body. If the send succeeds, acknowledge the rejected delivery. If the sender address is absent or the send fails, use the executable and state directory reported by `waypost_status` to run structured argv `[executable,"--state-dir",state_dir,"fail","--delivery",delivery_id,"--lease-token",lease_token,"--reason","malformed_action","--json"]`. Report its returned state; never release this delivery.
