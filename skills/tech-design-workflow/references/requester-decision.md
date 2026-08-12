---
skill-selector: requester-decision
selector-summary: Handle a requester-owned technical-design decision request.
selector-aliases: check-waypost-messages/action:design_spec_decision_requested
---

# Requester Decision

The author requests one precise user-owned decision. Ask the user for that decision, preserving the received options, recommendation, and exact current artifact path.

After the user answers, write one canonical Requester Decision Delta under `.agent-artifacts/message/`, preserving the answer verbatim and only resulting constraint changes. Send it unchanged to reviewer first as `design_spec_review_context` with `Context: decision`, effective round, identities, host, and maximum. Only after a delivery ID is returned, send the same delta unchanged to author as `design_spec_draft_requested` with the next artifact and unchanged archive branch/maximum. Record both delivery IDs. Surface partial or unknown delivery and do not retry automatically.

Retrieve `agentgear skill get tech-design-workflow requester-handling` only when the complete requester handling contract is needed.
