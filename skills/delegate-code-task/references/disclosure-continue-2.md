---
skill-selector: continue-2
selector-summary: Complete delegate-code-task instructions, part 3.
---

- Omit `## User Decisions` when no temporary scope decision exists.
- For `Outcome: completed`, send only when review is skipped. For `Outcome: blocked`, send under either policy; include any existing delivery commit. Send from the retained inbound `recipient_address` to its `sender_address` with subject `code delivery complete: <task_id>`; ack the claimed instruction only after send succeeds. The planner reports the blocker or runs closeout; do not run `review-closeout` or claim an accepted review.

## User-Facing Result

Return only:

- delegated objective
- persistent-session reason
- task and integration branches
- coder session id
- reviewer session id when review is required
- temporary workspace and cleanup status, when applicable
- any blocker or send failure
- any failed or unverified wake hint

Keep tool commands, addresses, raw JSON, and successful routine wakeup details internal. Use shared diagnostics internally; report only the concise failure cause.
