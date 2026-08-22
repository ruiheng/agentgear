---
skill-selector: review-request-route
selector-summary: Route a technical-design review request by draft or committed-doc mode.
selector-aliases: action:design_spec_review_requested
---

# Technical Design Review Request Route

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`. Route
without opening the target:

- workspace-relative `Lane Manifest` selects draft-round; retrieve
  `tech-design-workflow/lane-manifest`, then `review-tech-design/review-contract
  review-tech-design/draft-round-review review-tech-design/message-delivery`;
- otherwise require `Mode: committed-docs` under `## Review Target`, then
  retrieve `review-tech-design/review-contract
  review-tech-design/committed-docs-review review-tech-design/message-delivery`;
- conflicting or missing mode input is rejected with the generic response below.

Draft-round has no Mode field. Authenticate Task and author -> reviewer
transport endpoints against the manifest. Require schema 2, a positive Round
within `review_checkpoint`, a positive `review_checkpoint_interval`, and an artifact equal to
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`, the immediately
preceding artifact for later rounds, and a Context Revision equal to the current
Canonical Contract before opening the target. Use retained conversation and
artifact history to recognize an older or duplicate request. Defer missing
authority; reject a different task, endpoint, or target.

For committed-docs, retain the requester route, initial contract, decisions,
review checkpoint, and each reviewed target by Task and Round. Round 1 carries the full
contract. Later rounds preserve it, append any new exact User Decision Delta,
and name the previous reviewed commit. Require sequential positive rounds and
one request per Task/Round. Checkpoint continuation is workflow state, not a
User Decision Delta.

Apply `review-contract`, including `Round <= Review Checkpoint`, before opening
either target.

For an invalid discriminator, send to the inbound sender:

```markdown
Action: message_rejected
Original Delivery: <delivery_id>
Error: invalid_design_review_request

Expected a workspace-relative Lane Manifest for draft-round, or Mode: committed-docs under Review Target.
```

Use subject `message rejected: <delivery_id>`. Acknowledge after send success;
otherwise fail the claim under the Receiver Contract.
