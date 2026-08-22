---
skill-selector: requester-delivery
selector-summary: Assess, archive, and close out a delivered technical design.
selector-aliases: action:design_spec_delivered
---

# Requester Delivery

On `design_spec_delivered`:

1. Read the workspace-relative Lane Manifest. Match Task and the actual
   author/requester transport endpoints to its stable routes.
2. Require the named artifact to equal
   `.agent-artifacts/design-spec/<author_session_id>/rNNN.md` for the positive
   delivered Round. Require it to be a complete regular file. Match Decision and
   ordered Caveats to the delivered artifact: `SOUND` uses `None`, while
   `SOUND_WITH_CAVEATS` requires the same nonempty ordered list verbatim under
   `## Caveats`.
3. Retrieve `agentgear skill get assess-tech-design` and actively assess the
   artifact against the original request, current Canonical Contract, accepted
   user decisions expressed in the design, and repository evidence. Author and
   reviewer agreement is not a substitute. Return every substantive concern,
   including over-design, to the author for another reviewed round.
4. Reuse an existing committed formal doc only when it already represents the
   assessed design and exact caveats. Otherwise require the manifest archive
   branch as current, a clean index, and no merge/rebase/conflict state.
5. Copy and commit only the assessed design document. Any substantive archival
   edit returns to author review.
6. Retrieve `agentgear skill get tech-design-workflow/closeout`, then remove the
   task sessions. Use an initial pruner ID from the manifest or a lazy pruner ID
   from the authenticated delivery.

Treat the tracked committed document as authoritative. Report its path and
commit with the exact accepted decision and caveats, or `Caveats: None`.
