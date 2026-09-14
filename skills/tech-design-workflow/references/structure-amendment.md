---
skill-selector: structure-amendment
selector-summary: Roll a two-phase lane back from implementation to a revised structure document.
---

# Structure Amendment

On a two-phase lane, implementation-phase evidence that the recorded
`structure_doc` is wrong — a `structural` reviewer finding, the author's own
repository evidence, or a `structural` requester rejection finding — rolls back
to structure:

1. Stop implementation rounds. Open the amendment from the author workspace:

   ```bash
   agentgear run tech-design-workflow record-design-structure.mjs \
     --workdir "<current workspace>" \
     --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
     --open-amendment \
     --json
   ```

   It blocks implementation dispatch until a new structure is recorded.
2. Draft the next `sNNN.md` in the structure series. Its notes name the
   triggering implementation finding or rejection and which `rNNN` rounds the
   amendment supersedes. Apply the author-round minimum-architecture pass: the
   amendment re-derives structure from the Contract and evidence, not a patch
   over the recorded document.
3. Review and deliver the amendment exactly like any structure round
   (`--phase structure`), including the pruner and the structure checkpoint.
4. After the requester accepts the structure delivery, record it:

   ```bash
   agentgear run tech-design-workflow record-design-structure.mjs \
     --workdir "<current workspace>" \
     --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
     --structure-doc ".agent-artifacts/design-spec/<author_session_id>/sNNN.md" \
     --json
   ```

   This clears the pending amendment and moves the structural baseline
   forward. The recorded round must not move backwards.
5. Resume implementation at the next `rNNN`. Its notes carry an invalidation
   assessment: which sections of prior `rNNN` artifacts survive the new
   structure and which are rebuilt — anything from a narrow section rewrite to
   a fresh implementation in substance. Prior `rNNN` snapshots stay immutable;
   superseded artifacts are never edited or deleted.

If the amendment resolves without a structural change — the finding was
implementation-local, or the amendment proved unnecessary — re-record the
current `structure_doc` with `--structure-doc` to clear the pending amendment
instead of drafting a new `sNNN`.
