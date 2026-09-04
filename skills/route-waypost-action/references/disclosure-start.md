---
skill-selector: start
selector-summary: Load the prompt named by a received Waypost Action.
---

# Route Waypost Action

From the received `Action: <value>` line, explicitly use Agentgear `skill get` with
`action:<value>` as the first processing step, then follow the result. On
lookup failure, do not infer a workflow.
