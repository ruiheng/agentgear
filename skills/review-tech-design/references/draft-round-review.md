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
3. Reinspect source when a changed dependency, invariant, scope claim, or current evidence requires it.
4. Recheck the evidence needed for each conclusion rather than treating a cache or worktree fingerprint as proof.
5. Perform a bounded full-artifact consistency scan after the change-focused review.

Expand scope when evidence justifies it, and record why. If the prior artifact is missing or does not match the preceding reviewed target, return NEEDS_INPUT rather than silently rebuilding the baseline. Use stable finding IDs in the report when helpful.
