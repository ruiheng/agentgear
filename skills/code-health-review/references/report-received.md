---
skill-selector: report-received
selector-summary: Process a delivered code-health review result.
selector-aliases: check-waypost-messages/action:code_health_review_report
---

# Code Health Review Report

On `code_health_review_report`, treat the received advisory report as the completed review result. Continue requester-owned work from its findings; do not infer a code-delivery, commit, review-closeout, or new workflow action from the report.

For a terminal advisory result, surface only the concise assessment, material findings, and open questions. Keep tool commands, addresses, raw JSON, and routine transport details internal.

Retrieve `agentgear skill get code-health-review review continue-1` only when the report's context requires the complete advisory-review contract.
