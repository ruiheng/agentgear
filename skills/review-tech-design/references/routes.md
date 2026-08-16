---
skill-selector: review-request-route
selector-summary: Route a technical-design review request by draft or committed-doc mode.
selector-aliases: action:design_spec_review_requested
---

# Technical Design Review Request Route

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`. Route
without opening the target:

- workspace-relative `Lane State` selects draft-round; retrieve
  `tech-design-workflow/lane-state`, then `review-tech-design/review-contract
  review-tech-design/draft-round-review review-tech-design/message-delivery`;
- otherwise require `Mode: committed-docs` under `## Review Target`, then
  retrieve `review-tech-design/review-contract
  review-tech-design/committed-docs-review review-tech-design/message-delivery`;
- conflicting or missing mode input is rejected with the generic response below.

Draft-round has no Mode field. Authenticate Task, author -> reviewer endpoints,
current Round, and Review Epoch against `correctness_epoch`. Require the current
artifact and the lane's Context Revision to match the Canonical Contract before
opening the target. An authenticated older Round or epoch is a stale duplicate:
settle it without another review. Defer missing state; reject a different task,
endpoint, future epoch, or target.

For committed-docs, retain the requester route, initial contract, decisions,
maximum, and each reviewed target by Task and Round. Round 1 carries the full
contract. Later rounds preserve it, append any new exact User Decision Delta,
and name the previous reviewed commit. Require sequential positive rounds and
one request per Task/Round. The maximum stays fixed unless a Delta approves its
exact replacement.

Apply `review-contract`, including `Round <= Max Review Rounds`, before opening
either target.

For an invalid discriminator, send to the inbound sender:

```markdown
Action: message_rejected
Original Delivery: <delivery_id>
Error: invalid_design_review_request

Expected a workspace-relative Lane State for draft-round, or Mode: committed-docs under Review Target.
```

Use subject `message rejected: <delivery_id>`. Acknowledge after send success;
otherwise fail the claim under the Receiver Contract.
