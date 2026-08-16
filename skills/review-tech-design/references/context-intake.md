---
skill-selector: context-intake
selector-summary: Retain and validate user-authoritative technical-design review context.
selector-aliases: action:design_spec_review_context
---

# User Context Intake

As the direct Action selector, retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-state`.

Authenticate the initial requester -> reviewer notice against lane state:
matching Task, `Context: initial`, positive Context Revision, and no Round.
Missing lane authority defers; a different task, endpoint, or message shape is
rejected without retaining context or sending a context rejection.

Require a readable workspace-relative lane state, its participants, host, and
positive maximum. Read the complete Canonical Design Task Contract from
`context_file`. An authenticated notice older than that contract is a stale
no-op; otherwise require equal revisions plus Original Request or authoritative
handoff text and its source. Retain the latest revision and context by task. Do
not inspect a design from this message alone.

On each later draft review request, reread the contract and lane state. Require
the lane's applied Context Revision to match the contract, retain every unseen
applicable User Decision in file order, and treat zero new decisions as a valid
no-op. Agent summaries never replace missing user context.

For valid intake, retain context and settle the claimed delivery under the
shared Receiver Contract, then wait without replying. After the route gate
passes, missing or unsupported current-revision content retrieves `agentgear
skill get review-tech-design/message-delivery` and sends Context Rejection to
the actual inbound sender. Do not retain rejected context.
