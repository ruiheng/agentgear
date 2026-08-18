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
- [question and exact user answer, or None]

## Residual Risk
[remaining uncertainty or None]
```

Use `None` under Caveats for every decision except `SOUND_WITH_CAVEATS`.
`SOUND_WITH_CAVEATS` requires at least one caveat, copied verbatim and in the
same order from the reviewed target's `## Caveats` section. Never leave a caveat
only in Findings, Summary, or Residual Risk.

For draft-round, insert this after `Action`:

```markdown
Lane State: <workspace-relative lane state file>
Review Epoch: <positive review generation>
Artifact SHA-256: <review_gate.artifact_sha256>
```

Draft-round resolves task, epoch, round, reviewer identity, maximum, user
context, and target from that shared lane state. Committed-docs omits Lane State
and Review Epoch and resolves context from the inline request plus preceding
rounds. Message reports use only their routed mode; direct-use sets
`Mode: direct`. Never require draft-only state from committed-docs.

Send the complete report form above as the Waypost body; never replace it with a summary, and keep `Action: design_spec_review_report` in its initial header block. Send completed reviews or NEEDS_INPUT to the received request `sender_address` from the current bound reviewer address with subject `design-spec review report: <task_id> r<round>`. Follow the shared Async sender rule.

If required user context is unavailable, send `NEEDS_INPUT` and stop. Do not accept an agent-written substitute.

## Context Rejection

For invalid context, send `design_spec_review_context_rejected` to the actual
inbound `sender_address` with this body:

```markdown
Task: <task_id>
Action: design_spec_review_context_rejected
Context: initial
Context Revision: <received context revision>
Lane State: <workspace-relative lane state file or received value>

## Correction Needed
<precise correction>
```

Use no Round. Echo the rejected revision. Send
subject `design context rejected: <task_id>`. Settle only after send success and
wait for corrected context.

In context intake mode, valid intake is retained and settled without a reply. In direct-use mode, do not send Waypost.
