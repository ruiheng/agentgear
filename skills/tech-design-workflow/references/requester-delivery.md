---
skill-selector: requester-delivery
selector-summary: Archive and close out a delivered accepted technical design.
selector-aliases: action:design_spec_delivered
---

# Requester Delivery

On `design_spec_delivered`:

1. Retrieve `agentgear skill get tech-design-workflow/lane-state`. Require the workspace-relative `Lane State`, reread it, and require Task and Round to match the notification. Verify the actual `sender_address` is the recorded author route and the current `recipient_address` is the recorded requester route.
2. Require `acceptance.round`, `acceptance.artifact`, and `acceptance.artifact_sha256` to match the notification and `review_gate`. Run the Gate Verification defined by `lane-state` and require the freshly calculated digest to match all three. Require `review_gate` to match that Round, artifact, applied Context Revision, and current User Decision count. Require the applied Context Revision to equal the current contract, `correctness_report.epoch == correctness_epoch`, the report digest to match, an accepting correctness decision, and every report User Decision already retained in lane authority. When a pruner is enabled, require `prune_report.epoch == prune_epoch`, its digest to match, and `MINIMAL`; otherwise require prune epoch/report to remain null.
3. Require the notification Decision and ordered Caveats to exactly match `correctness_report`. `SOUND` requires `None` in the notification and an empty state list. `SOUND_WITH_CAVEATS` requires at least one exact caveat in both places, and the same ordered list must appear verbatim under `## Caveats` in the accepted artifact.
4. Retrieve `agentgear skill get assess-tech-design` and actively assess the accepted artifact against the original request, current Canonical Contract, exact User Decisions, and relevant repository evidence. Do not treat author/reviewer agreement as a substitute. Ask the user for material missing information. Return every substantive concern—including over-design, unnecessary compatibility, weak ownership, or missing caveats—to the author for another immutable reviewed round. Continue only when the assessment finds no required design change or unresolved decision.
5. Reuse an existing committed formal doc only when it already represents the assessed design and exact caveats.
6. Otherwise require the recorded archive branch as current, a clean index, and no merge/rebase/conflict state.
7. Choose a tracked docs path and stop if it has unrelated changes.
8. Make only trivial non-substantive archival edits locally; any substantive change returns to the author and repeats reviewer, optional pruner, and requester assessment gates.
9. Copy and commit only the assessed caveat-bearing design document.
10. Retain the exact accepted decision and caveats, retrieve `agentgear skill get tech-design-workflow/closeout`, then archive and remove task sessions.

Treat the tracked committed document as authoritative for implementation. In
the final response, report its path and commit together with the exact accepted
decision and every caveat, or `Caveats: None` for `SOUND`.
