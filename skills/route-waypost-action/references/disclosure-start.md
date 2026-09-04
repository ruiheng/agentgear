---
skill-selector: start
selector-summary: Load the prompt named by a received Waypost Action.
---

# Route Waypost Action

From the received `Action: <value>` line, use Agentgear `skill get` with
`action:<value>` and follow the result. If lookup reports an unknown, ambiguous,
or otherwise invalid Action, call `waypost_status` with
`include_cli_context: true`. Use its reported `executable` and
`resolved_state_dir` to permanently dead-letter the current claim:

Invoke these exact argv values; keep every value as one argument:

```text
[
  executable,
  "--state-dir", resolved_state_dir,
  "dead-letter",
  "--delivery", delivery_id,
  "--lease-token", lease_token,
  "--reason", "unknown_action",
  "--json"
]
```

Use the corresponding status or claim values. If only a shell string is
available, shell-quote every substituted value using that shell's escaping
rules before invoking it. A successful command permanently settles the routing
failure. If it exits nonzero, parse the one JSON error object from stderr. Retry
the identical dead-letter argv only when its `retryable` field is `true` and the
claim's lease remains valid. For `false`, missing, malformed, or absent error
output, report the claim unsettled immediately. Never use `waypost_ack`,
`waypost_release`, `waypost_defer`, the Waypost `fail` command, or a workflow as
a fallback. If a permitted retry still fails, report the claim unsettled and
stop; do not claim completion.
