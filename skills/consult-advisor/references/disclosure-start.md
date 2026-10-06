---
skill-selector: start
selector-summary: Open and run a consultation with a dedicated advisor session.
---

# Consult Advisor

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for Waypost transport and lifecycle; retrieve `agentgear skill get multi-agent-protocol/session-host multi-agent-protocol/tool-resolution` before session work.

Consult a persistent advisor session for judgment that tests and objective checks cannot settle: important user-facing copy, prompt wording, design direction, or a tradeoff the requester cannot confidently close alone. Do not consult for work a verifiable lane settles on its own.

## Inputs

- `consult_id`: explicit -> `YYYYMMDD-HHMM-<slug>`
- `requester_session_id`: explicit -> live Waypost context -> ask
- advisor workspace: the requester's workdir; the advisor may edit consulted files there but never owns branch or delivery state

A consultation needs an addressable requester (`waypost_status.default_sender`) for the reply route; without one, tell the user and stop. If creation rejects the requester as parent, ask the user to create the advisor session manually, then `session_require` it.

## Advisor Launch

The advisor runs a user-chosen high-capability model; agentgear ships no default. Use only a user-supplied command or the user's configured candidates; never substitute another role's profile.

1. explicit user-provided full command -> use it unchanged; explicit profile -> resolve that profile
2. otherwise resolve role `advisor`:

   ```bash
   agentgear resolve-tool-command --role advisor --workdir <advisor workspace> --show-list --format json
   ```

3. no candidate or resolver failure -> stop and ask the user for the advisor command line or to configure the `advisor` role

## Dispatch

1. With a recorded advisor for this `consult_id`, `session_require` it and reuse on `ready`. Otherwise create:

   `session_create` with `parent_session_id = <requester_session_id>`, `session_name = advisor-<consult_id>`, `workdir = <advisor workspace>`, the selected candidate's launch values, and `transition_notify = false` / `assert_done = false`; continue only on `status = created`.

2. Record the returned host, real session id, and sole address; every later turn and deletion needs them.

3. `waypost_send` from `waypost_status.default_sender` to the recorded address, subject `advisor consult: <consult_id>`:

   ```markdown
   Task: <consult_id>
   Action: advisor_consult

   Apply the `route-waypost-action` skill.

   <the question and what the answer feeds; context, constraints, and material as inline text or durable advisor-readable refs>
   ```

4. Follow the shared Message delivery and continuation rule; the reply arrives as `advisor_reply` on a later wakeup. Until then, leave the consulted files untouched: the advisor may edit them directly.

## Follow-Up Turns

Send another `advisor_consult` envelope to the recorded address; the advisor keeps its session context. Require the recorded session again only when it is known stopped; on `not_found` recreate it under the same name, update the record, and resend the context the new session needs.

## Ending

The requester owns the advisor's lifespan: keep it while follow-ups are foreseeable. When the discussion has concluded and none are foreseen soon, delete it through the shared cleanup path and drop the record:

```bash
agentgear run multi-agent-protocol archive-and-remove-task-sessions.mjs \
  --task-id <consult_id> \
  --owner-session-id <requester_session_id> \
  --session-host <advisor host> \
  --target advisor=<advisor_session_id> \
  --apply
```

On guard or deletion failure, preserve the session and report the pending cleanup with its manual step; do not retry automatically.
