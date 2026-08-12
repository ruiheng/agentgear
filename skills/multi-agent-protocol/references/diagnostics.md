---
skill-selector: diagnostics
selector-summary: Diagnose shared multi-agent workflow transport and session failures.
---

# Error Handling and Diagnostics

Use this shared checklist after listener, send, worker-start, or closeout failure.

1. Report a concise stderr summary.
2. Resolve the sender or target with the generic `session_resolve` operation.
3. Confirm the command runs in the expected workflow session context.
4. Check the relevant send, receive, or lifecycle tool result.

- Waypost state is host-scoped; CLI or wrapper use needs host permission.
- If denied, escalate instead of retrying unchanged.
- A send requires a delivery id; empty output or a non-`sent` lock needs recovery.
- Treat target status as diagnostic only; retry a nudge or resend only during explicit troubleshooting.
- For closeout or cleanup failure, include the blocker, generated artifact path, and exact manual unblock step.
