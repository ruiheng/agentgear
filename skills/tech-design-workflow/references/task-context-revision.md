---
skill-selector: task-context-revision
selector-summary: Apply a requester-relayed user-authoritative change to an active draft lane.
selector-aliases: action:design_task_context_revision
---

# Design Task Context Revision

Use only for an exact user-authoritative product or scope change relayed from the
draft lane requester to its author. Retrieve `agentgear skill get
multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate Task and Lane Manifest, then require the actual sender and
recipient to match the manifest requester and author routes. Distinguish the
exact User Decision Delta from supporting requester context; unclear user
authority is a blocker.

Record the decision in the Canonical Contract as a new Context Revision without
rewriting its history. Use normal judgment to incorporate it into current work
and reconsider affected review. Keep dispatched artifacts immutable; retrieve
`agentgear skill get tech-design-workflow/author-round` when revision is needed.
