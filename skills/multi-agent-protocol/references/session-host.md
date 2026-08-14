---
skill-selector: session-host
selector-summary: Require, create, and close collaborator sessions through Waypost.
---

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

## Require or Create

For a target id or ref:

1. Call `session_require` with the known host when present, the expected
   `workdir`, and exactly one of `session_id`, `session_ref`, or an ordered
   `sessions` batch. Leave `auto_restart` at its default for a target that must
   be ready. Continue on `status = ready`, preserving the returned identity.
2. On `status = not_found`, retain the recorded workflow-owned parent's exact id.
   Resolve the workflow role by `agentgear skill get multi-agent-protocol/tool-resolution`, then call
   `session_create` with the parent host when known, `session_name`, `workdir`,
   `parent_session_id`, and the selected candidate's `full_command_line` /
   `thurbox_agent_key`. `session_create` verifies the exact parent identity and
   independently verifies the child against the requested workdir; the parent
   may belong to a different workspace. Do not call `session_require` on a
   parent merely as creation preflight.
   Continue only when `status = created`.

Use `auto_restart = false` only for read-only inspection. An existing stopped
target then returns `status = not_ready`; do not send work to it. A normal
dispatch may require its returned exact id again with automatic restart.

Generic creation always needs a same-host parent. It has no detached,
parentless, group-placement, or startup-instruction form. An action that cannot
name a portable parent must ask the user to create the direct session manually,
then require it.

If creation rejects the recorded parent or child workdir, report that exact
error. Do not inspect a host CLI or session inventory, and do not replace the
recorded parent with an unrelated session.

Do not retry or send work after `created_unverified`,
`create_recovery_required`, or `ready_unverified`. Keep the returned identity,
use `session_require` with `auto_restart = false` only for recovery inspection,
and ask for an operator-approved next step.

## Launch Values

`session_create` accepts two optional values supplied by the caller:

- `full_command_line`: used by hosts that launch an agent command, including
  Agent Deck;
- `thurbox_agent_key`: used only by Thurbox as its configured `--agent` key.

Waypost consumes the value for the selected host and does not read resolver
configuration, infer a key, or inspect Thurbox's configuration. The caller may
pass both opaque values from one resolver candidate.

## Lifecycle Boundary

Ordinary workflow turns may require, create, send to, and report
sessions. They must not delete, restart, move, group, or otherwise manage a
host through its CLI. The designated successful closeout path is the exception:
it removes task-scoped disposable sessions through the owning host adapter,
using exact recorded ids and that adapter's ownership guards. Preserve and
report sessions when the host has no supported cleanup adapter or a guard
fails. Explicitly reusable sessions are never disposable. Waypost delivery is
durable truth; a host wake is only a best-effort hint.

Closeout scripts accept cleanup targets as repeatable `<role>=<real_id>`
entries. Action skills decide the roles and exact ids; adding a workflow role
must not add another role-specific option to the shared cleanup interface.

When a durable send succeeds but its wake is failed or unverified, report the
wake result and stop. The host may have submitted the hint despite a false
negative. Do not resend, press Enter, restart, inspect, or otherwise repair the
target session unless the user explicitly authorizes troubleshooting that
specific session.
