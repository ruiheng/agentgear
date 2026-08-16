---
skill-selector: report-received
selector-summary: Process a delivered simplification review result.
selector-aliases: action:simplify_review_report
---

# Simplify Review Report

If this session has a matching active `simplify_review_requested` request,
require Task, Round, and the actual sender to match its selected reviewer before
treating the report as that request's result. Otherwise surface it as an
unsolicited advisory report. Do not search Waypost history merely to prove an
advisory correlation.

Continue requester-owned work from useful findings; do not infer a code-delivery, commit, review-closeout, or new workflow action from the report.

For a terminal advisory result, surface only the concise assessment, material findings, and open questions. Keep tool commands, addresses, raw JSON, and routine transport details internal.

Retrieve `agentgear skill get simplify-review/review` only when the report's context requires the complete advisory-review contract.
