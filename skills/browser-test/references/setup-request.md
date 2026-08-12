---
skill-selector: setup-request
selector-summary: Request or prepare browser validation setup.
selector-aliases: check-waypost-messages/action:browser_setup_requested
---

# Browser Setup Request

## Setup Request Receive

On `browser_setup_requested`, resolve the received route before replying:

- require `Browser Check`; if it is absent, fail the claimed message and request a fresh setup request. Never infer it from Task or Round.
- resolve `task_id` and `round` from the received headers;
- resolve the tester identity and `tester_workspace` from `From` and `Reply workspace`;
- resolve the setup-contact identity and role from `To`;
- require the tester with `session_require` at the declared `tester_workspace`, and use its returned sole Waypost address. Do not replace that workspace with the contact's current workspace or an inferred default.

Reply `browser_setup_provided` to that tester with the same Task, Round, and Browser Check. Include setup details or `Unavailable: <reason>`, then acknowledge the claim. Never send secrets through Waypost.

Use the current bound setup-contact address as sender, the required tester address as recipient, and subject `browser setup: <task_id> r<round>`. A send failure leaves the claim unacknowledged for Receiver Contract settlement.
