---
skill-selector: author-convergence
selector-summary: Assess draft-lane convergence at a review checkpoint; advance or escalate.
---

# Checkpoint Convergence Assessment

When the just-reviewed round reached `review_checkpoint`, the next round's
notes file also carries the convergence assessment: unresolved-finding trend,
reopened finding families, and unresolved reviewer/pruner contradictions. A
checkpoint reached undelivered is risk evidence — "converging" needs the
recorded trend, not optimism.

Converging — findings shrinking, none reopened, no deadlocked contradiction —
needs no user decision. Advance the checkpoint and continue:

```bash
agentgear run tech-design-workflow advance-design-review-checkpoint.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --expected-current-checkpoint "<current checkpoint>" \
  --json
```

Otherwise stop before a new artifact: report the structural risk, its
evidence, the affected user outcome, and the decision the user owns. Resume on
their direction; a "continue" decision ends with the same advance. Checkpoint
continuation does not change the Canonical Contract or Context Revision.
