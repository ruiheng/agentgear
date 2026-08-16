---
skill-selector: requester-delivery
selector-summary: Archive and close out a delivered accepted technical design.
selector-aliases: action:design_spec_delivered
---

# Requester Delivery

On `design_spec_delivered`:

1. Retrieve `agentgear skill get tech-design-workflow/lane-state`. Require the workspace-relative `Lane State`, reread it, and require Task and Round to match the notification. Verify the actual `sender_address` is the recorded author route and the current `recipient_address` is the recorded requester route.
2. Require `acceptance.round` and `acceptance.artifact` to match the notification and an existing artifact. Require the applied Context Revision to equal the current contract, `correctness_report.epoch == correctness_epoch`, an accepting correctness decision, and every report User Decision already retained in lane authority. When a pruner is enabled, require `prune_report.epoch == prune_epoch` and `MINIMAL`; otherwise require prune epoch/report to remain null.
3. Require the notification Decision and ordered Caveats to exactly match `correctness_report`. `SOUND` requires `None` in the notification and an empty state list. `SOUND_WITH_CAVEATS` requires at least one exact caveat in both places, and the same ordered list must appear verbatim under `## Caveats` in the accepted artifact.
4. Reuse an existing committed formal doc only when it already represents the accepted design and exact caveats.
5. Otherwise require the recorded archive branch as current, a clean index, and no merge/rebase/conflict state.
6. Choose a tracked docs path and stop if it has unrelated changes.
7. Return substantive changes, including missing or altered caveats, to the author for another reviewed round; make only trivial non-substantive archival edits locally.
8. Copy and commit only the accepted caveat-bearing design document.
9. Retain the exact accepted decision and caveats, retrieve `agentgear skill get tech-design-workflow/closeout`, then archive and remove task sessions.

Treat the tracked committed document as authoritative for implementation. In
the final response, report its path and commit together with the exact accepted
decision and every caveat, or `Caveats: None` for `SOUND`.
