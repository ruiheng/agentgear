# Draft-Round Review

Require one named complete `.agent-artifacts/design-spec/<author_session_id>/rNNN.md` target. Do not edit it or switch to a newer round. Use prior rounds only for comparison, never to supply missing specification content.

## Reviewer-Owned State

Use `.agent-artifacts/design-review/<reviewer_session_id>/<task_id>/` exclusively. Only the reviewer writes this directory. Maintain:

- `evidence-index.md`: verified conclusions, source paths/symbols, verification round, and explicit invalidation conditions;
- `review-ledger.md`: stable Finding IDs, status, opening/closing round, affected sections, related Evidence IDs, and acceptance/reopen rationale;
- generated diff and machine state from `prepare-incremental-review.mjs`.

The Evidence Index is an investigation cache, not authority. Mark entries `verified`, `stale`, `rejected`, or `superseded`. A useful entry states its conclusion, exact evidence, repository baseline, last confirmed round, and what changes invalidate it.

## Prepare the Round

For round 1, run after initial evidence discovery and pass every verified repository file with repeated `--record-evidence`:

```bash
agentgear run review-tech-design prepare-incremental-review.mjs \
  --workdir "<workspace>" \
  --task-id "<task_id>" \
  --reviewer-session-id "<reviewer_session_id>" \
  --round 1 \
  --current-artifact ".agent-artifacts/design-spec/<author_session_id>/r001.md" \
  --record-evidence "path/to/source" \
  --json
```

For round 2+, require `Previous reviewed artifact` and run the same command with `--previous-artifact` pointing to that exact prior target. First run without new `--record-evidence` values to obtain diff and stale evidence. After any necessary repository checks, rerun with every newly verified or reverified path so the machine cache records the current hashes.

## Incremental Review Algorithm

For round 1, perform the full independent repository investigation needed to judge the target.

For round 2 and later:

1. Read the generated machine diff first.
2. Map each material change to stable prior Finding IDs and affected Evidence IDs.
3. Reinspect source only for stale/missing evidence, changed dependencies or invariants, newly introduced scope, repository HEAD/worktree changes relevant to the conclusion, or contradictions in the complete current artifact.
4. Inherit previously accepted unchanged conclusions by default.
5. Perform a bounded full-artifact consistency scan after the change-focused review; do not restart broad repository discovery merely because the artifact is complete.

Expand scope when evidence justifies it, and record why. If the prior artifact is missing or does not match the preceding reviewed target, return NEEDS_INPUT rather than silently rebuilding the baseline.

Update the Evidence Index and Review Ledger before sending the report. Use stable IDs such as `E-001` and `R1-F01`; never renumber historical entries.
