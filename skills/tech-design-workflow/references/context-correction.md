---
skill-selector: context-correction
selector-summary: Correct rejected shared technical-design context.
selector-aliases: action:design_spec_review_context_rejected
---

# Design Context Correction

Use for reviewer context rejection or pruner `NEEDS_INPUT` with `Input Kind:
context-initial`. Retrieve `agentgear skill get multi-agent-protocol/shared-protocol
tech-design-workflow/lane-manifest`.

When the manifest and author route authenticate, require reviewer/pruner ->
author transport, matching Task and Lane Manifest, and the rejected Context
Revision. The author rereads the latest Canonical Contract, applies the precise
correction while preserving existing User Decision Deltas, and increments
Context Revision. Ask the user directly if authority is missing.

An already-applied correction is a no-op. Continue in the same lane; the next
review or prune request carries the new revision. No separate context message is
needed.

If the manifest or author route cannot authenticate, the rejection returns to
the requester as a lane-setup failure. The requester reports the failure and
does not edit the Contract.
