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

`User Decisions` records review-relevant product or scope answers. Checkpoint
continuation is not recorded here.

Use `None` under Caveats for every decision except `SOUND_WITH_CAVEATS`.
`SOUND_WITH_CAVEATS` requires at least one caveat, copied verbatim and in the
same order from the reviewed target's `## Caveats` section. Never leave a caveat
only in Findings, Summary, or Residual Risk.

For draft-round, insert this after `Action`:

```markdown
Lane Manifest: <workspace-relative lane manifest>
Artifact: <reviewed artifact>
```

Draft-round resolves participant identity, review checkpoint, interval, and
contract path from the manifest, while the authenticated request names the exact round,
artifact, previous artifact, and Context Revision. Committed-docs omits Lane Manifest
and resolves context from the inline request plus preceding
rounds. Message reports use only their routed mode; direct-use sets
`Mode: direct`. Never require draft-only state from committed-docs.

Send the complete form to the request `sender_address` from the bound reviewer
address, subject `design-spec review report: <task_id> r<round>`. Keep
`Action: design_spec_review_report` in the initial header. Draft-review's author
records confirmed User Decision Deltas; committed-docs' requester records them.
Record exact answers only. Follow the shared Message delivery and continuation rule.

Use `NEEDS_INPUT` only when the review request is incomplete, mismatched, or
unreadable. If user input is needed, ask the user directly and wait before
sending the report; include the exact question and answer under `## User
Decisions`. Do not send an unanswered question or use `NEEDS_INPUT` for ordinary
technical uncertainty.

## Context Rejection

For invalid Contract context with an authenticated manifest and author route,
send `design_spec_review_context_rejected` to the manifest's author address. If
that route cannot authenticate, send it to the inbound requester as a lane-setup
failure. Use this body:

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
