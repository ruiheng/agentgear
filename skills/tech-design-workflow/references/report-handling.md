---
skill-selector: report-handling
selector-summary: Handle an incoming technical-design review report.
selector-aliases: check-waypost-messages/action:design_spec_review_report
---

# Review Report Handling

The session that sent the review request handles the returned report. Preserve Max Review Rounds, including user-approved extensions.

- `NEEDS_INPUT`: correct review input and resend the same valid target.
- `NEEDS_REVISION`: create the next complete target.
  - draft-review: copy the reviewed artifact to the next numbered path, revise the copy, and leave the reviewed path unchanged;
  - review-existing: update and commit docs on the same design branch.
- `SOUND`: accept.
- `SOUND_WITH_CAVEATS`: accept only when every caveat is non-blocking and already recorded in the reviewed target; otherwise revise.
- disagreement: send concise rationale to the same reviewer for the same round; do not replace the target or increment the round.

Use stable finding IDs from the review report. In the next artifact, make each addressed finding traceable to the affected sections. Do not edit reviewer-owned artifacts or state.

If a dispute repeats or requires a subjective product/strategy choice, the author sends `design_spec_decision_requested`; a review-existing requester asks the user directly.

After acceptance:

- draft-review: author sends `design_spec_delivered`; requester archives and commits it;
- review-existing:
  1. read the accepted commit from Reviewed Scope;
  2. require the design branch tip to equal it;
  3. rerun the path gate;
  4. require committed specifications, switch to the recorded base, and merge normally;
  5. read `closeout.md` and clean up the reviewer;
  6. report final paths and resulting base HEAD.

For review-existing, do not squash, rebase, cherry-pick, or guess through dirty state, conflicts, detached HEAD, or base uncertainty.
