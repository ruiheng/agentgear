---
skill-selector: shared-protocol
selector-summary: Apply shared message envelopes, receiver claims, and workflow lifecycle rules.
---

# Multi-Agent Collaboration Protocol

Use this contract for session identity, message boundaries, and delivery lifecycle.
Action skills own role behavior; companion references own shared execution policy.

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

Every workflow message has:

- `subject`: one-line triage summary
- `body`: the action-specific input

A workflow may put common requester-owned context in one workspace file when every recipient has the same verified workdir. Send the workspace-relative path instead of copying that context into each message, and keep the file available through workflow closeout.

Use the smallest header that selects the action and correlates its work:

```markdown
Task: <task_id_or_N/A>
[a stable Action header chosen by the owning workflow]
[action-specific correlation fields only]
```

`message_rejected` is the sole header exception: malformed or unknown input may
have no trustworthy Task, so its exact templates begin with Action and correlate
only by `Original Delivery`.

`Action:` is a stable token. The action skill owns its meaning and any extra fields.
Do not copy transport routing into body `From` or `To` headers. The claimed
delivery's `sender_address` and `recipient_address` are authoritative. Reply to
the received `sender_address` from the current `recipient_address`; carry a
role, session id, host, or workspace in the body only when the action uses it
as task data rather than as a send route.

Do not use the envelope as a second workflow-state store. When an action names
a shared workspace state file, keep mutable task, participant, round, limit,
and artifact state there. The message only identifies the action, task, shared
state file, and any immutable event correlation needed to reject stale work.

## Expected Sender Gate

Before a claimed result causes merge, acceptance, cleanup, code changes, or
another workflow transition, match its Task and action-specific correlation to
the active request or lane. Require the actual `sender_address` to be that
lane's expected worker and `recipient_address` to be its recorded return route.
Do not substitute body identity fields. Missing authority defers; an endpoint or
lane mismatch is rejected without acting on the result. An authenticated older
round or generation is a stale no-op, not a routing failure.

Advisory-only reports do not require exact sent-history recovery. Match a known
active reviewer when available; otherwise present the report as unsolicited and
do not infer a workflow transition. Local same-turn continuations do not use
this gate.

## Waypost Host Permission Boundary

Waypost state is host-scoped. Prefer MCP; run Waypost CLI or wrappers with host
permission. If denied, escalate instead of retrying unchanged.

## Collaborator Privacy Boundary

Never inspect another session's input, output, or Waypost data without explicit
user authorization.

## Delivery Contract

1. Follow Target Lifecycle Gate.
2. Queue the message with `waypost_send`.
3. Follow Async sender rule.

Only a returned delivery id is send success; empty output or a non-`sent` lock
is unresolved.

## Async sender rule

- `waypost_send` completes delivery; replies are later inbound work.
- After sending, continue independent work; do not poll for the reply.
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
3. Use `body` as the primary input and delivery metadata as routing authority. A message without an Action field is an ordinary personal message. A valid Action selects its action skill; an explicit malformed or unknown Action is rejected to its received `sender_address`.
4. Settle each claimed delivery according to its current state:
   - `waypost_ack` when its immediate required action is complete, including handing a required decision to the user
   - `waypost_release` or `waypost_defer` only when the delivery itself cannot be handled now
   - the reported Waypost CLI `fail` command when a routing rejection cannot be returned
5. Continue receiving other useful work when appropriate. One claim is not a global receive lock; do not hold an unprocessable delivery merely to preserve ordering.

## Natural End Gate

Before ending, settle every delivery still claimed by this session. Queued, released, or deferred work may remain pending. If message context is lost, recover it with `waypost_read`.
