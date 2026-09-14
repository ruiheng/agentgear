---
skill-selector: report-handling
selector-summary: Handle an incoming technical-design review report or delivery rejection.
selector-aliases: action:design_spec_review_report, action:design_prune_report, action:design_spec_delivery_rejected
---

# Review Report Handling

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`; draft mode
also retrieves `tech-design-workflow/lane-manifest`.

Authenticate the actual sender and recipient endpoints before acting:

- draft correctness: recorded reviewer -> author;
- draft pruning: requested pruner -> author;
- initial prune-context rejection: requested pruner -> author;
- delivery rejection: recorded requester -> author;
- committed-docs: retained reviewer -> requester.

For pruner `NEEDS_INPUT` with `Input Kind: context-initial`, retrieve
`tech-design-workflow/context-correction`. For any other draft report, require its
Task, Round, artifact, and lane manifest to match
the request being handled; on a two-phase lane also match the report's `Phase`
to the reviewed artifact's series (`sNNN` is `structure`, `rNNN` is
`implementation`). Use retained conversation and dispatched artifacts
to recognize older or duplicate reports. The lane manifest records only phase
state; round progress and reports stay in messages and artifacts.

Apply the report with ordinary agent judgment:

The reviewed snapshot is immutable. Apply accepted changes only by creating the
next numbered snapshot in the same series (`sNNN.md` or `rNNN.md`); never patch
the reviewed file in place, even for a minor wording change. On a two-phase
lane, a `structural` blocking finding on an implementation artifact — one the
recorded structure cannot accommodate — is not an `rNNN` revision: follow
`author-round`'s structure amendment protocol.

A `design_spec_delivery_rejected` notice from the requester lists findings
under `## Findings`. Disposition each one in the next round's notes exactly
like a reviewer finding; a structural rejection finding opens the amendment
protocol. The rejected artifact stays immutable.

In unattended mode, a received report is input to the next lane action, not a
reason to return a status update and wait. Continue revision, re-dispatch, or
delivery while the Contract and checkpoint policy permit it; stop only for a
material user decision or the explicit checkpoint/blocker rules below.

- `NEEDS_INPUT`: correct missing or invalid review input. Resolve ordinary
  technical questions through evidence, findings, or revision;
- `NEEDS_REVISION` / `NEEDS_SIMPLIFICATION`: after every requested role reports,
  record each finding's disposition in the next round's notes file, then apply
  the author-round continuation rules before creating the next complete
  artifact.
- `SOUND`: accept correctness only with no caveats;
- `SOUND_WITH_CAVEATS`: require every caveat to appear verbatim and in order in
  the reviewed artifact;
- `MINIMAL`: record that no Contract-based simplification was found and use that
  exact immutable artifact as the next same-phase pruner baseline; it is not
  architectural approval and does not override the author's Contract-based
  judgment.

Wait for reviewer and pruner when both were requested. Resolve disagreements
from evidence; a rebuttal rides the next dispatch's notes file so the role
re-evaluates it. Escalate to the user only under `author-round`'s ordered stop
conditions.

For any draft report with `User Decisions`, append each exact question and
answer to the Canonical Contract as a User Decision Delta and increment Context
Revision before revision or delivery. Reuse an already recorded answer. Reflect
the decision in the design when relevant. The next review dispatch carries the
new revision; no separate context notification is needed.

After active reports accept the artifact, follow `author-round` for delivery.
Keep accepted caveats in the next artifact and final delivery, not in a shared
progress database.
For review-existing, retain the accepted commit at the design tip, rerun its path
gate, merge into the recorded base, and close out the reviewer. Never squash,
rebase, cherry-pick, or guess through dirty or conflicting Git state.
