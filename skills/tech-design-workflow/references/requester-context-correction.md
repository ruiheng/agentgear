---
skill-selector: requester-context-correction
selector-summary: Correct requester context rejected by the reviewer.
selector-aliases: check-waypost-messages/action:design_spec_review_context_rejected
---

# Requester Context Correction

On `design_spec_review_context_rejected`, correct the named context and send it to the reviewer again. After reviewer delivery succeeds, send every corrected shared lane field to the author: use `design_spec_context_corrected` for metadata-only corrections, or `design_spec_draft_requested` for authority/design changes. Do not rerun initial dispatch or edit a reviewed artifact.

Retrieve `agentgear skill get tech-design-workflow requester-handling` only when the complete requester handling contract is needed.
