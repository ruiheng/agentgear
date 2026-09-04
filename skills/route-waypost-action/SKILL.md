---
name: route-waypost-action
description: Use when a received Waypost message contains a line starting with `Action:`.
---

From the received `Action: <value>` line, explicitly use Agentgear `skill get` with
`action:<value>` as the first processing step, then follow the result. On
lookup failure, do not infer a workflow.
