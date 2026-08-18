---
skill-selector: context-intake
selector-summary: Retain and validate user-authoritative technical-design review context.
selector-aliases: action:design_spec_review_context
---

# User Context Intake

As the direct Action selector, retrieve `agentgear skill get
multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate the initial requester -> reviewer notice using Task, actual
transport endpoints, `Context: initial`, positive Context Revision, and the
stable Lane Manifest. Read the Canonical Contract from its `context_file` and
require the same revision plus Original Request or authoritative handoff.

Retain that user-authoritative context in the reviewer session. A duplicate or
older authenticated notice is a stale no-op. Do not record progress in the
manifest and do not inspect a design from a context notice alone.

For each later review request, reread the contract and require the message's
Context Revision to match. Missing or unsupported current context retrieves
`review-tech-design/message-delivery` and sends Context Rejection to the actual
inbound sender. Valid intake is retained and settled without a reply.
