---
skill-selector: draft-round-review
selector-summary: Independently review one immutable draft technical design round.
---

# Draft-Round Review

Require one named complete `.agent-artifacts/design-spec/<author_session_id>/rNNN.md` target. Do not edit it or switch to a newer round. Use prior rounds only for comparison, never to supply missing specification content.

## Round Review Algorithm

For round 1, perform the full independent repository investigation needed to judge the target.

For round 2 and later:

Require `previous_artifact` to be the existing immediately preceding immutable
snapshot, then read its ordinary diff to the current target. If retained review
state proves that you reviewed that snapshot under the same Context Revision and
the same retained User Decisions, map changes to prior findings, reuse unchanged evidence,
reinspect affected or contradictory source, and scan the complete current
artifact for consistency. Otherwise derive the current review frame again and
review the complete target independently; unchanged repository facts may be
reused, but the diff is only navigation and no prior conclusion is inherited.

Expand scope when evidence justifies it, and record why. Return NEEDS_INPUT only
when the previous snapshot is missing or is not the immediately preceding one.
Use stable finding IDs in the report when helpful.

For a newer Review Epoch on the same artifact and Round, perform a normal review
against the current contract and every retained decision. A concise author
rationale may focus attention but does not limit the independent review or
create a special finding protocol.
