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
- initial prune-context rejection: requested pruner -> requester;
- committed-docs: retained reviewer -> requester.

For a draft report, require its Task, Round, artifact, and lane manifest to match
the request being handled. Use retained conversation and immutable artifact
history to recognize an older or duplicate report. Do not copy reports,
decisions, caveats, delivery status, or progress into the lane manifest.

Apply the report with ordinary agent judgment:

- `NEEDS_INPUT`: obtain the missing user authority or correct the shared contract;
- `NEEDS_REVISION` / `NEEDS_SIMPLIFICATION`: after every requested role reports,
  create the next complete immutable artifact;
- `SOUND`: accept correctness only with no caveats;
- `SOUND_WITH_CAVEATS`: require every caveat to appear verbatim and in order in
  the reviewed artifact;
- `MINIMAL`: accept pruning.

Wait for reviewer and pruner when both were requested. Resolve disagreements
from evidence or ask the relevant role for another ordinary review. Incorporate
exact user answers into the design rather than maintaining a parallel authority
log.

After the active reports accept the artifact, follow `author-round` delivery.
Keep accepted caveats in the next artifact and final delivery, not in a shared
progress database.
For review-existing, retain the accepted commit at the design tip, rerun its path
gate, merge into the recorded base, and close out the reviewer. Never squash,
rebase, cherry-pick, or guess through dirty or conflicting Git state.
