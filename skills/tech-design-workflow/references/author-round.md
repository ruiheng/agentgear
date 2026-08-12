# Author Round

## Route Corrections and Recovery

On `design_spec_context_corrected`, update only named shared lane fields. Keep the current artifact unchanged. Authority or design-content changes require a new `design_spec_draft_requested` round.

On `design_spec_review_context_recovery_requested` with `Relay: requester`, recover the requester route and relay Task, Reviewer, Author, Session Host, Round, maximum, Missing Context, and Pending Review unchanged. Do not supply, reconstruct, or summarize requester context.

## Draft Execution

On `design_spec_draft_requested`:

1. Recover requester, reviewer, host, round, maximum, canonical contract, artifact, archive branch, and prior reviewed target when round > 1.
2. For round 1, inspect the relevant repository and user-aligned context. For later rounds, start from the prior review findings and the copied prior artifact; re-open source only when the revision changes a dependency/invariant or reviewer evidence is stale.
3. Write the complete, proportional, implementation-ready design to the named round path. Only the author writes `.agent-artifacts/design-spec/<author_session_id>/`.
4. Keep accepted constraints and rationale in the artifact, not only in messages.
5. Send the review request below, leave the artifact unchanged, and follow the Async sender rule.

Resolve core approach, data structures, interfaces, ownership, boundaries, material flows, migration and validation choices, relevant state/configuration/compatibility effects, failure behavior, benefits, risks, alternatives, and user-owned decisions. Every material component must link directly to the requester goal or a hard constraint. Exclude speculative flexibility, duplicate paths, unnecessary abstraction, and unrequested cross-domain capability.

## Review Request

Send from `waypost_status.default_sender` to the recorded reviewer address with subject `design-spec review: <task_id> r<round>`:

```markdown
Task: <task_id>
Action: design_spec_review_requested
From: architect_author <author_session_id>
To: architect_reviewer <reviewer_session_id>
Session Host: <session_host>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Requester Context
- Source: pre-delivered requester contract and Decision Deltas

## Review Target
- Mode: draft-round
- Artifact: .agent-artifacts/design-spec/<author_session_id>/rNNN.md
- Previous reviewed artifact: <exact rNNN-1 path | none for round 1>
- Review state: .agent-artifacts/design-review/<reviewer_session_id>/<task_id>/
```

For round 2 and later, the previous artifact is required and must be the exact target reviewed in the preceding report. Do not paste or summarize the design, provide a hand-written diff, restate requester context, or declare evidence valid. The reviewer generates the machine diff and owns evidence state.

## Final Notification

After an accepted report, send `design_spec_delivered` to the requester with task, author, requester, reviewer, host, final artifact, archive branch, accepted decision, and report message ID. Do not repeat design content or implementation advice. The requester owns archival and closeout.
