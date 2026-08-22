---
skill-selector: context-correction
selector-summary: Correct rejected shared technical-design context and notify its consumers.
selector-aliases: action:design_spec_review_context_rejected
---

# Design Context Correction

Use for reviewer rejection or authenticated pruner `NEEDS_INPUT` with
`Input Kind: context-initial`. Retrieve `agentgear skill get
multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate Task, `Context: initial`, positive Context Revision, absence of
Round, and the reviewer/pruner -> requester endpoints against the lane or
retained dispatch identity. An older authenticated rejection may still identify
an unresolved correction; an already-applied one is a no-op. Defer missing
authority and reject a different task or endpoint before changing context.

For this initial-context rejection, the requester atomically publishes one
complete corrected Canonical Contract in the manifest's `context_file`,
preserving exact user wording and increasing Context Revision. It never modifies
the lane manifest. Agents recognize older reports from retained context.

Notify every consumer to reread the shared contract:

```markdown
Task: <task_id>
Action: design_spec_review_context
Context: initial
Context Revision: <new revision>
Lane Manifest: <workspace-relative lane manifest>
```

```markdown
Task: <task_id>
Action: design_prune_context
Context: initial
Context Revision: <new revision>
Lane Manifest: <workspace-relative lane manifest>
```

```markdown
Task: <task_id>
Action: design_spec_context_corrected
Context: initial
Context Revision: <new revision>
Lane Manifest: <workspace-relative lane manifest>
```

Send from the requester to the recorded reviewer, enabled pruner, and author.
The author decides whether the current dispatched snapshot remains valid. Settle
the rejection after the contract write and required notifications succeed; an
explicit retry may repeat the same revision safely.
