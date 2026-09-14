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
   `.agent-artifacts/design-spec/<author_session_id>/<letter>NNN.md` for the
   positive delivered Round, where the letter matches the delivery's `Phase`:
   `s` for `structure`, `r` for `implementation`. A single-phase lane and an
   omitted `Phase` mean `r`. Require it to be a complete regular file. Match
   Decision and ordered Caveats to the delivered artifact: `SOUND` uses
   `None`, while `SOUND_WITH_CAVEATS` requires the same nonempty ordered list
   verbatim under `## Caveats`. Require `Pruner Decision: MINIMAL` for
   structure and single-phase deliveries unless policy is `never`; for
   `never`, and for implementation deliveries on a two-phase lane, reject that
   field. An implementation delivery also names `Structure:`; require it to
   equal the manifest's recorded `structure_doc`.
3. Retrieve `agentgear skill get assess-tech-design` and actively assess the
   artifact against the original request, current Canonical Contract, accepted
   user decisions expressed in the design, and repository evidence. Author and
   reviewer agreement is not a substitute. For a structure delivery require a
   minimum complete structural specification that owns only what the Contract
   assigns this lane; for an implementation or single-phase delivery require a
   coder-facing specification of the current intended change that stays inside
   the recorded structure. Keep relevant requirements and decisions; reject
   drafting history, review dialogue, and process details with no
   implementation value.
4. Return every substantive concern to the author through
   `design_spec_delivery_rejected` (below). Each finding must be actionable:
   name the violated Contract term, the incorrect repository fact, or the
   structure to remove — never a bare magnitude judgment like "too large"
   without the removable content. A finding the recorded structure cannot
   accommodate is marked `structural`; it rolls the lane back to a structure
   amendment rather than another `rNNN` revision.
5. On acceptance of a structure delivery, archive and commit the accepted
   `sNNN` document on the manifest archive branch, then send the author a
   `design_spec_draft_requested` notice with `Phase: implementation`,
   `Artifact: .agent-artifacts/design-spec/<author_session_id>/r001.md`,
   `Round: 1`, and `Structure: <accepted sNNN path>`. The lane continues —
   do not close out.
6. On acceptance of an implementation or single-phase delivery, reuse an
   existing committed formal doc only when it already represents the assessed
   design and exact caveats. Otherwise require the manifest archive branch as
   current, a clean index, and no merge/rebase/conflict state. Copy and commit
   only the assessed design document. Any substantive archival edit returns to
   author review.
7. Retrieve `agentgear skill get tech-design-workflow/closeout`, then remove
   the task sessions. Use an initial pruner ID from the manifest or a lazy
   pruner ID from an authenticated delivery.

Send a delivery rejection to the manifest's author address:

```markdown
Task: <task_id>
Action: design_spec_delivery_rejected
Lane Manifest: <workspace-relative lane manifest>
Phase: <rejected delivery phase>
Artifact: <rejected artifact>
Round: <rejected round>

## Findings
- <actionable finding; mark `structural` when the recorded structure must change>

## Requester Context
<supporting evidence; omit when empty>
```

Treat the tracked committed documents as authoritative. Report their paths and
commits with the exact accepted decision and caveats, or `Caveats: None`.
