---
skill-selector: draft-round-review
selector-summary: Independently review one immutable draft technical design round.
---

# Draft-Round Review

Require one named complete `.agent-artifacts/design-spec/<author_session_id>/rNNN.md` target. Do not edit it or switch to a newer round. Use prior rounds only for comparison, never to supply missing specification content.

## Round Review Algorithm

For round 1, perform the full independent repository investigation needed to judge the target.

For round 2 and later:

1. Read an ordinary diff between the immutable prior and current artifacts.
2. Map material changes to prior findings and affected constraints.
3. Reuse prior evidence from unchanged source. Reinspect only source affected by the artifact diff, repository changes, or a current contradiction.
4. Perform a bounded consistency scan of the complete current artifact, not another repository scan.

Expand scope when evidence justifies it, and record why. If the prior artifact is missing or does not match the preceding reviewed target, return NEEDS_INPUT rather than silently rebuilding the baseline. Use stable finding IDs in the report when helpful.
