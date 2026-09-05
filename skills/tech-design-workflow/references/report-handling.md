---
skill-selector: report-handling
selector-summary: Handle an incoming technical-design review report.
selector-aliases: action:design_spec_review_report, action:design_prune_report
---

# Review Report Handling

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`; draft mode
also retrieves `tech-design-workflow/lane-manifest`.

Authenticate the actual sender and recipient endpoints before acting:

- draft correctness: recorded reviewer -> author;
- draft pruning: requested pruner -> author;
- initial prune-context rejection: requested pruner -> author;
- committed-docs: retained reviewer -> requester.

For pruner `NEEDS_INPUT` with `Input Kind: context-initial`, retrieve
`tech-design-workflow/context-correction`. For any other draft report, require its
Task, Round, artifact, and lane manifest to match
the request being handled. Use retained conversation and dispatched artifacts
to recognize older or duplicate reports. Keep workflow progress out of the lane
manifest.

Apply the report with ordinary agent judgment:

- `NEEDS_INPUT`: correct missing or invalid review input. Resolve ordinary
  technical questions through evidence, findings, or revision;
- `NEEDS_REVISION` / `NEEDS_SIMPLIFICATION`: after every requested role reports,
  create the next complete artifact; when the report reaches a review
  checkpoint, stop before creating it and follow the risk analysis and user
  report in `author-round`;
- `SOUND`: accept correctness only with no caveats;
- `SOUND_WITH_CAVEATS`: require every caveat to appear verbatim and in order in
  the reviewed artifact;
- `MINIMAL`: record that no Contract-based simplification was found and use that
  exact immutable artifact as the next pruner baseline; it is not architectural
  approval and does not override the author's Contract-based judgment.

Wait for reviewer and pruner when both were requested. Resolve disagreements
from evidence or ask the relevant role for another ordinary review.

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
