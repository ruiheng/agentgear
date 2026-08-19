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
Round: <round>

## Summary
[One-line conclusion]

## Reviewed Scope
- Mode: <draft-round | committed-docs | direct>
- Artifact/Commit/Docs: <exact reviewed target>
- Previous target: <exact target | none>

## Persisted Data Changes
[Material changes, or None]

## Decision
SOUND | SOUND_WITH_CAVEATS | NEEDS_REVISION | NEEDS_INPUT

## Caveats
- [Exact caveat copied from the reviewed target, or None]

## Findings
- [Stable Finding ID: consequence and recommended direction, or None]

## User Decisions
- [exact user-input question and answer, or None]

## Residual Risk
[remaining uncertainty or None]
```

The `User Decisions` heading is the lane's complete user-input record. It may
contain factual clarifications, constraints, preferences, or decisions.

Use `None` under Caveats for every decision except `SOUND_WITH_CAVEATS`.
`SOUND_WITH_CAVEATS` requires at least one caveat, copied verbatim and in the
same order from the reviewed target's `## Caveats` section. Never leave a caveat
only in Findings, Summary, or Residual Risk.

For draft-round, insert this after `Action`:

```markdown
Lane Manifest: <workspace-relative lane manifest>
Artifact: <reviewed artifact>
```

Draft-round resolves participant identity, maximum, and contract path from the
stable manifest, while the authenticated request names the exact round,
artifact, previous artifact, and Context Revision. Committed-docs omits Lane Manifest
and resolves context from the inline request plus preceding
rounds. Message reports use only their routed mode; direct-use sets
`Mode: direct`. Never require draft-only state from committed-docs.

Send the complete report form above as the Waypost body; never replace it with a summary, and keep `Action: design_spec_review_report` in its initial header block. Send completed reviews or `NEEDS_INPUT` to the received request `sender_address` from the current bound reviewer address with subject `design-spec review report: <task_id> r<round>`. The requester records any confirmed User Decision Delta; it is not the authority to answer user questions on the user's behalf. Follow the shared Async sender rule.

Use `NEEDS_INPUT` only when the review request is incomplete, mismatched, or
unreadable. If user input is needed, ask the user directly and wait before
sending the report; include the exact question and answer under `## User
Decisions`. Do not send an unanswered question or use `NEEDS_INPUT` for ordinary
technical uncertainty.

## Context Rejection

For invalid context, send `design_spec_review_context_rejected` to the actual
inbound `sender_address` with this body:

```markdown
Task: <task_id>
Action: design_spec_review_context_rejected
Context: initial
Context Revision: <received context revision>
Lane Manifest: <workspace-relative lane manifest or received value>

## Correction Needed
<precise correction>
```

Use no Round. Echo the rejected revision. Send
subject `design context rejected: <task_id>`. Settle only after send success and
wait for corrected context.

In context intake mode, valid intake is retained and settled without a reply. In direct-use mode, do not send Waypost.
