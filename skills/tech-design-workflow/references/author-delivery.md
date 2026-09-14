---
skill-selector: author-delivery
selector-summary: Deliver an accepted technical design artifact to the requester.
---

# Author Delivery

Deliver after correctness accepts the artifact and, with an enabled pruner,
the pruner has accepted that same artifact with `MINIMAL`. When an accepted
artifact has no pruner report for that snapshot — every implementation
artifact on a two-phase lane, where the pruner enters only as this
post-acceptance gate — request one with `--pruner-only`, adding the pruner
identity unless the manifest records it and omitting baseline and
structural-change options. An implementation gate still names
`--structure-doc`. It sends only to the pruner and keeps the round.

Send to the manifest's requester address:

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane Manifest: <workspace-relative lane manifest>
[Phase: <structure|implementation — two-phase lanes only>]
Artifact: <accepted artifact>
Round: <accepted round>
Decision: <SOUND | SOUND_WITH_CAVEATS>
[Structure: <recorded sNNN path — implementation deliveries only>]
[Pruner Decision: MINIMAL]
[Pruner Session ID: <lazy pruner real id>]

## Caveats
- <exact accepted caveat in artifact order | None>
```

Use `None` for `SOUND`. Include `Phase` on a two-phase lane. Include `Pruner
Decision` for every delivery unless policy is `never`. Include the lazy pruner
session ID only when the requester did not create it.

A two-phase lane delivers twice. After the requester accepts the structure
delivery, record it:

```bash
agentgear run tech-design-workflow record-design-structure.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --structure-doc ".agent-artifacts/design-spec/<author_session_id>/sNNN.md" \
  --json
```

Then continue into implementation round 1. The implementation delivery is
terminal; the requester owns assessment, archival, and closeout. A rejected
delivery returns as `design_spec_delivery_rejected` — handle it under
`tech-design-workflow/report-handling`.
