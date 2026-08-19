---
skill-selector: draft-round-review
selector-summary: Independently review one immutable draft technical design round.
---

# Draft-Round Review

Require one named complete `.agent-artifacts/design-spec/<author_session_id>/rNNN.md`
target. Do not edit it or switch to a newer round. Use prior rounds only for
comparison, never to supply missing specification content.

## Round Review Algorithm

For round 1, perform the full independent repository investigation needed to
judge the target.

For round 2 and later, require the message to name the existing immediately
preceding immutable artifact. Read its ordinary diff to the current target. If
your retained conversation and reports show that you reviewed that snapshot
under the same Context Revision and user decisions, map changes to prior
findings, reuse unchanged evidence, reinspect affected or contradictory source,
and scan the complete current artifact for consistency. Otherwise derive the
review frame again and review the complete target independently. The diff is
navigation, not inherited approval.

Expand scope when evidence justifies it, and record why. Ask the user directly
and wait for the answer when required user input cannot be inferred; include the
exact question and answer in the report. Return `NEEDS_INPUT` only when the
review request or required artifact is missing, mismatched, or unreadable.
Use stable finding IDs when helpful. A concise author rationale may focus
attention but does not limit the independent review.
