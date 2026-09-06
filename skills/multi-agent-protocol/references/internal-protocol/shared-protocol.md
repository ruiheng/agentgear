---
skill-selector: shared-protocol
selector-summary: Apply shared message envelopes, receiver claims, and workflow lifecycle rules.
---

# Multi-Agent Collaboration Protocol

This contract owns message identity and lifecycle; action skills own role behavior.

## Multi-Agent Mode Detection

Enter multi-agent mode when any condition matches:

- workflow metadata includes a task or session id
- an inbound message carries workflow metadata
- the user explicitly requests coordinated multi-agent work

## Context Resolution Priority

`explicit input -> message/workflow context -> deterministic default -> ask`

- Resolve the current collaborator session and its routeable Waypost address
  from the active session manager or Waypost context.
- Use a session ref only before a real id exists; record and use the real id afterward.
- Treat a missing required session id as context loss unless the action declares its target on demand.

## Target Lifecycle Gate

- At first dispatch, or when target identity/workdir is uncertain, create or require the target collaborator session.
- Later, require a confirmed target only when it is known not to be running; otherwise send to its real id.
- The action skill owns target-specific creation and reuse; follow the shared
  tool-resolution and session-host contracts before creating a session.
- Creating a collaborator session is workflow lifecycle, not a host-subagent API call.
  Use the generic session-host contract; do not infer the host in an action
  prompt.

## Message Envelope

Every message has `subject` (triage summary) and `body` (action input).

With a shared verified workdir, keep common requester context in one file;
send its relative path and retain it through closeout.

Use the smallest header that selects the action and correlates its work:

```markdown
Task: <task_id_or_N/A>
[a stable Action header chosen by the owning workflow]
[action-specific correlation fields only]
```

Use `Action:` only when the owning workflow defines the exact stable token and
its receiver instructions. Never invent, rename, or approximate an Action. If
no specialized Action applies, use `Action: generic` for ordinary collaboration;
it adds no specialized workflow behavior.

`message_rejected` may omit Task because it correlates by `Original Delivery`;
its exact templates begin with Action and Original Delivery.

`Action:` is a stable token. The action skill owns its meaning and any extra fields.
Do not put transport routes in body `From` or `To` headers. Use actual delivery
addresses; action-specific destinations come from task records. A forwarding
collaborator does not replace the original author or the action's reply route.

Keep mutable task, participant, round, limit, and artifact state in the action's
shared state file. Messages identify the action, task, state file, and immutable
event correlation; do not duplicate mutable state in the envelope.

## Expected Sender Gate

Before a workflow transition, match Task, lane, round/generation, and other
action correlation to the active request. Accept the expected sender or an
unchanged forward from a recorded task collaborator with matching original
author and request context. Resolve roles and routes from task records, not
body identity claims alone. Stale messages do not advance the workflow.

Advisory-only reports do not require exact sent-history recovery. Match a known
active reviewer when available; otherwise present the report as unsolicited and
do not infer a workflow transition. Local same-turn continuations do not use
this gate.

## Routing Recovery

A valid Action does not assign its receiver a new role. If misdirected, use
the owning skill and task records to forward it unchanged to the intended
recipient, then notify the sender; ack the mistaken delivery only after both
sends succeed. On a correction, fix the route and resume the pending handoff;
do not resend an already forwarded message. If the route is unknown, ask the sender; ack
only after that request succeeds. Never silently consume actionable work as
a notification. Missing task context requires clarification, not guessed action.

## Waypost Host Permission Boundary

Waypost state is host-scoped. Prefer MCP; run Waypost CLI or wrappers with host
permission. If denied, escalate instead of retrying unchanged.

## Collaborator Privacy Boundary

Never inspect another session's input, output, or Waypost data without explicit
user authorization.

## Delivery Contract

1. Follow Target Lifecycle Gate.
2. Queue the message with `waypost_send`.
3. Follow Message delivery and continuation.

Only a returned delivery id is send success; empty output or a non-`sent` lock
is unresolved.

## Message delivery and continuation

- `waypost_send` completes delivery; replies are later inbound work.
- Push coordination: continue after sending; keep routine state internal.
  Send only required handoffs, blockers, checkpoints, or terminal results; do
  not poll.
- Keep target execution receiver-owned. A failed or unverified wake does not
  reverse durable delivery and may be a false negative. A workflow whose fixed,
  non-assertive wake notice is explicitly replayable may replay it once in the
  same wrapper invocation; it may skip the replay for a just-created delivery
  already leased or acknowledged, but a failed state check does not block the
  replay. Never resend the Waypost message or replay from a later wrapper run.
  Otherwise do not press Enter, restart, inspect, or repair the target unless
  the user explicitly authorizes troubleshooting that specific session.

## Receiver Contract

On a wakeup nudge or explicit user message check:

1. Call `waypost_recv` first.
2. If no personal message is returned, report it; `no_message` ends this receive pass.
3. Use `body` as the primary input and delivery metadata as routing authority. A message without an Action field is an ordinary personal message. An Action field selects its action skill; an unknown, ambiguous, or otherwise invalid Action is a permanent routing failure, so do not infer or substitute a workflow.
4. Settle each claimed delivery according to its current state:
   - `waypost_ack` when its immediate required action is complete, including handing a required decision to the user
   - `waypost_release` or `waypost_defer` only when handling is temporarily unavailable and retry remains appropriate
   - the reported Waypost CLI `dead-letter` command, using the `executable` and `resolved_state_dir` from `waypost_status` with `include_cli_context: true` and preserving each value as one argv argument, for an unknown, ambiguous, invalid, or otherwise permanently unroutable Action
   - the reported Waypost CLI `fail` command only when processing failed but retry remains appropriate
   - If the `dead-letter` command exits nonzero, parse its one JSON error object from stderr and preserve the permanent routing decision. Retry the identical command only when its `retryable` field is `true` and the claim's lease remains valid. For `false`, missing, malformed, or absent error output, report the claim unsettled immediately. Never replace it with `waypost_ack`, `waypost_release`, `waypost_defer`, the Waypost `fail` command, or a workflow. If a permitted retry still fails, report the claim unsettled and stop; do not claim completion.
5. Use the available Waypost receive interface to process available work;
   repeat it only while draining known pending work. Continue receiving other
   useful work when appropriate. One claim is not a global receive lock; do not
   hold an unprocessable delivery merely to preserve ordering.

User corrections steer the task; apply and continue. New task only for explicit scope change. Recover context via `waypost_read` and the artifact.

## Natural End Gate

Before ending, settle every delivery still claimed by this session. Queued, released, or deferred work may remain pending. A claim whose terminal `dead-letter` settlement failed and cannot be safely retried is reported as unsettled rather than given a different settlement. If message context is lost, recover it with `waypost_read`.
