---
skill-selector: setup-request
selector-summary: Request or prepare browser validation setup.
selector-aliases: action:browser_setup_requested
---

# Browser Setup Request

## Setup Request Receive

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`.

On `browser_setup_requested`, resolve the received route before replying:

- require `Browser Check`; if it is absent, fail the claimed message and request a fresh setup request. Never infer it from Task or Round.
- resolve `task_id` and `round` from the received headers;
- use the received `sender_address` as the tester reply route;
- use the current delivery recipient as the setup contact;
- reply directly to that opaque route; do not parse it as a session id or pass it to `session_require`.

Reply with this complete body:

```markdown
Task: <task_id>
Action: browser_setup_provided
Round: <round>
Browser Check: <browser_check_id>

## Setup
<setup details, or Unavailable: reason>
```

Preserve the received Task, Round, and Browser Check. Never send secrets through
Waypost.

Use the received delivery's `recipient_address` as sender and `sender_address`
as recipient, with subject `browser setup: <task_id> r<round>`. A send failure
leaves the claim unacknowledged for Receiver Contract settlement.
