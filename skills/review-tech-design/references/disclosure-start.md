---
skill-selector: start
selector-summary: Complete review-tech-design instructions, part 1.
---

# Review Technical Design

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for shared transport. Route message actions to their direct selector; load review details only after that selector chooses the mode.

## Route First

- `design_spec_review_context`: retrieve `agentgear skill get review-tech-design/context-intake`.
- `design_spec_review_requested`: retrieve `agentgear skill get review-tech-design/review-request-route`; that selector owns mode choice, authentication, and downstream references.
- Every non-message invocation is direct-use mode: retrieve `agentgear skill get review-tech-design/review-contract review-tech-design/message-delivery`, review the readable target named by the user, and do not send Waypost.
