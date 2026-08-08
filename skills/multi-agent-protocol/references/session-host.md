# Session Host Contract

Waypost owns session-host detection, dispatch, and wake hints. Workflow prompts
use its generic session tools; they never inspect `THURBOX_SESSION`, call a
host CLI, or construct an `agent-deck/<id>` or `thurbox/<id>` address.

## Generic Operations

Use the preferred Waypost MCP operations for lifecycle work:

- `session_resolve`: find a session by real id or deterministic ref before a
  possible create
- `session_create`: create a named session in an explicit workdir
- `session_require`: verify and make an existing session ready; it never
  creates one

The selected session result records its host, real id, name, status, workdir,
parent when available, and routeable Waypost address or addresses. Preserve the
returned real id and use a returned address for every `waypost_send`; never
derive an address from the id.

## Host Selection

Omit `host` for ordinary current-session work. Specify it only when the user
chooses a host or persisted workflow context already identifies the host. Do
not ask the executing agent to detect a host: Waypost resolves that boundary
or returns an actionable ambiguity/error.

## Creation

Use `session_name`, `workdir`, and the logical `launch_profile` accepted by the
selected host. Pass `parent_session_id` only when the workflow owns a parent
relationship. Do not include Agent Deck groups, raw launch commands, or other
provider-specific arguments in common workflow prompts.

The host-profile mapping is an operator configuration concern. A common action
skill chooses a workflow role and records its resolved logical profile; it does
not encode a model command or a Thurbox agent name.

## Lifecycle

Keep session teardown provider-specific and explicit. Generic workflow turns
may create, resolve, require, send to, and report sessions, but must not call a
host CLI to delete a session. Waypost delivery remains durable truth; a host
wake is only a best-effort hint.
