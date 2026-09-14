---
skill-selector: author-convergence
selector-summary: Assess draft-lane convergence at a review checkpoint; advance or escalate.
---

# Checkpoint Convergence Assessment

Each phase has its own checkpoint: `structure_checkpoint` gates `sNNN` rounds
and `review_checkpoint` gates `rNNN` rounds on a two-phase lane; a
single-phase lane has only `review_checkpoint`. When the just-reviewed round
reached its phase's checkpoint, the next round's notes file also carries the
convergence assessment: unresolved-finding trend,
reopened finding families, and unresolved reviewer/pruner contradictions. A
checkpoint reached undelivered is risk evidence — "converging" needs the
recorded trend, not optimism.

Converging — findings shrinking, none reopened, no deadlocked contradiction —
needs no user decision. Advance that phase's checkpoint and continue:

```bash
agentgear run tech-design-workflow advance-design-review-checkpoint.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --phase "<structure|implementation>" \
  --expected-current-checkpoint "<current checkpoint>" \
  --json
```

`--phase` is required on a two-phase lane and selects which checkpoint
advances; a single-phase lane omits it.

Otherwise stop before a new artifact: report the structural risk, its
evidence, the affected user outcome, and the decision the user owns. Resume on
their direction; a "continue" decision ends with the same advance. Checkpoint
continuation does not change the Canonical Contract or Context Revision.
