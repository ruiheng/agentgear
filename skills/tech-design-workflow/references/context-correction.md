---
skill-selector: context-correction
selector-summary: Correct rejected shared technical-design context and notify its consumers.
selector-aliases: action:design_spec_review_context_rejected
---

# Design Context Correction

Use for reviewer rejection or authenticated pruner `NEEDS_INPUT` with
`Input Kind: context-initial`. Retrieve `agentgear skill get
multi-agent-protocol/shared-protocol tech-design-workflow/lane-state`.

Authenticate Task, `Context: initial`, positive Context Revision, absence of
Round, and the reviewer/pruner -> requester endpoints against the lane or
retained dispatch identity. An older authenticated rejection may still identify
an unresolved correction; an already-applied one is a no-op. Defer missing
authority and reject a different task or endpoint before changing context.

The requester atomically publishes one complete corrected Canonical Contract in
the same `context_file`, preserving exact user wording and increasing Context
Revision. It never writes lane state. Old review results become stale when the
author applies the new revision and prepares the next review epoch.

Notify every consumer to reread the shared contract:

```markdown
Task: <task_id>
Action: design_spec_review_context
Context: initial
Context Revision: <new revision>
Lane State: <workspace-relative lane state file>
```

```markdown
Task: <task_id>
Action: design_prune_context
Context: initial
Context Revision: <new revision>
Lane State: <workspace-relative lane state file>
```

```markdown
Task: <task_id>
Action: design_spec_context_corrected
Context: initial
Context Revision: <new revision>
Lane State: <workspace-relative lane state file>
```

Send from the requester to the recorded reviewer, enabled pruner, and author.
The author decides whether the current immutable snapshot remains valid. Settle
the rejection after the contract write and required notifications succeed; an
explicit retry may repeat the same revision safely.
