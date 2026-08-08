# Session Host Contract

Waypost owns host detection, session dispatch, and wake hints. Common workflow
prompts never inspect `THURBOX_SESSION`, call a host CLI, or construct a host
address. Launch values come from the shared resolver, never from a prompt.

## Start With Bound Context

Call `waypost_status` before a host operation. Use its `default_sender` as the
current sender address. Preserve a returned session's `host`, real
`session_id`, canonical `path`, and sole item in `addresses`; an address is
always consumed from that result and never derived from an id.

When a workflow already records a host, pass it explicitly. Otherwise omit
`host` only for current-session work: Waypost selects a valid nested Thurbox
session first, then Agent Deck, or returns an actionable error.

## Resolve, Require, Create

For a target ref:

1. Call `session_resolve` with exactly one `session` (or an ordered `sessions`
   batch) and the known host when present.
2. If it is found, call `session_require` with its returned `host`, exact
   `session_id`, and expected `workdir`. Continue only when `status = ready`.
3. If it is not found, first require the workflow-owned parent and retain that
   parent's returned host and exact id. Resolve the workflow role by
   `tool-resolution.md`, then call `session_create` with that host,
   `session_name`, `workdir`, `parent_session_id`, and the selected candidate's
   `full_command_line` / `thurbox_agent_key`. Continue only when
   `status = created`.

Generic creation always needs a same-host parent with the same verified
workdir. It has no detached, parentless, group-placement, or startup-instruction
form. An action that cannot name a portable parent must ask the user to create
the direct session manually, then resolve and require it.

Do not retry or send work after `created_unverified`,
`create_recovery_required`, or `ready_unverified`. Keep the returned identity,
call `session_resolve` only for recovery inspection, and ask for an
operator-approved next step.

## Launch Values

`session_create` accepts two optional values supplied by the caller:

- `full_command_line`: used by hosts that launch an agent command, including
  Agent Deck;
- `thurbox_agent_key`: used only by Thurbox as its configured `--agent` key.

Waypost consumes the value for the selected host and does not read resolver
configuration, infer a key, or inspect Thurbox's configuration. The caller may
pass both opaque values from one resolver candidate.

## Lifecycle Boundary

Generic workflow turns may resolve, require, create, send to, and report
sessions. They must not delete, restart, move, group, or otherwise manage a
host through its CLI. Waypost delivery is durable truth; a host wake is only a
best-effort hint.
