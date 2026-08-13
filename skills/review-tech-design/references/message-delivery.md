---
skill-selector: message-delivery
selector-summary: Deliver a technical-design review report and handle context failures.
---

# Review Report and Delivery

## Report Form

Use this form for message review; omit the envelope in direct-use mode:

```markdown
Task: <task_id>
Action: design_spec_review_report
From: architect_reviewer <reviewer_session_id>
To: <review_sender_role> <review_sender_session_id>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Summary
[One-line conclusion]

## Reviewed Scope
- Mode: <draft-round | committed-docs>
- Artifact/Commit/Docs: <exact reviewed target>
- Previous reviewed target: <exact target | none>
- Review state: <reviewer-owned path | none>

## Persisted Data Changes
[Required]

## Decision
SOUND | SOUND_WITH_CAVEATS | NEEDS_REVISION | NEEDS_INPUT

## Findings
- [Stable Finding ID: consequence and recommended direction, or None]

## Questions To Resolve
- [requester-owned decision or blocker, or None]

## Residual Risk
[remaining uncertainty or None]
```

In message review, resolve task, round, reviewer identity, actual inbound From identity, maximum, requester context, and target through shared context rules. Send the complete report form above as the Waypost body; never replace it with a summary, and keep `Action: design_spec_review_report` in its initial header block. Send completed reviews and NEEDS_INPUT to inbound From after `session_resolve`, using the current bound reviewer Waypost address and subject `design-spec review report: <task_id> r<round>`. Follow the shared Async sender rule.

## Context Recovery

When draft-round requester context is missing, record the pending exact target and send `design_spec_review_context_recovery_requested` directly to the retained requester, or to inbound author with `Relay: requester` only when the requester route is unavailable. Include reviewer, author, host, round, maximum, Missing Context, and Pending Review unchanged. Settle the inbound review claim after the send succeeds. Do not send NEEDS_INPUT or accept author-supplied replacement context. Resume only after exact requester replays, marking the last `Recovery Complete: yes`.

## Context Rejection

For invalid context, send `design_spec_review_context_rejected` to the actual inbound sender address with task/received value, context kind, round, and precise correction needed. Use subject `design context rejected: <task_id>`. Settle only after send success; wait for corrected requester context and do not route the failure through the author.

In context intake mode, valid intake is retained and settled without a reply. In direct-use mode, do not send Waypost.
