---
skill-selector: requester-delivery
selector-summary: Archive and close out a delivered accepted technical design.
selector-aliases: check-waypost-messages/action:design_spec_delivered
---

# Requester Delivery

On `design_spec_delivered`:

1. Verify the artifact exists and the report accepted that exact path.
2. Reuse an existing committed formal doc when it already represents the accepted design.
3. Otherwise require the delivered archive branch as current, a clean index, and no merge/rebase/conflict state.
4. Choose a tracked docs path and stop if it has unrelated changes.
5. Return substantive changes to the author for another reviewed round; make only trivial non-substantive archival edits locally.
6. Copy and commit only the accepted design document.
7. Retrieve `agentgear skill get tech-design-workflow closeout`, archive and remove task sessions, then report the tracked doc and commit.

Treat the tracked committed document as authoritative for implementation. Retrieve `agentgear skill get tech-design-workflow requester-handling` only when the complete requester handling contract is needed.
