---
skill-selector: requester-delivery
selector-summary: Archive and close out a delivered accepted technical design.
selector-aliases: action:design_spec_delivered
---

# Requester Delivery

On `design_spec_delivered`:

1. Retrieve `agentgear skill get tech-design-workflow/lane-state`. Require the workspace-relative `Lane State`, reread it, and require Task and Round to match the notification. Verify the actual `sender_address` is the recorded author route and the current `recipient_address` is the recorded requester route.
2. Require `acceptance.round` and `acceptance.artifact` to match the notification and an existing artifact. Require the applied Context Revision to equal the current contract, `correctness_report.epoch == correctness_epoch`, an accepting correctness decision, and every report User Decision already retained in lane authority. When a pruner is enabled, require `prune_report.epoch == prune_epoch` and `MINIMAL`; otherwise require prune epoch/report to remain null.
3. Reuse an existing committed formal doc when it already represents the accepted design.
4. Otherwise require the recorded archive branch as current, a clean index, and no merge/rebase/conflict state.
5. Choose a tracked docs path and stop if it has unrelated changes.
6. Return substantive changes to the author for another reviewed round; make only trivial non-substantive archival edits locally.
7. Copy and commit only the accepted design document.
8. Retrieve `agentgear skill get tech-design-workflow/closeout`, archive and remove task sessions, then report the tracked doc and commit.

Treat the tracked committed document as authoritative for implementation.
