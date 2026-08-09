# Open Review Findings

Status: open

Recorded: 2026-08-09

Scope: uncommitted session-host, permission-initialization, and workflow-closeout changes on `feature/thurbox-session-host`.

These findings are recorded for follow-up. Recording them does not imply that the proposed fixes have been accepted or implemented.

## P1

1. **Revoke stale Claude MCP grants.** Waypost MCP permissions added by `agent-deck-workflow-init-permissions.mjs` are not recorded as initializer-owned permissions. If Waypost later becomes unavailable or untrusted, or the managed tool list shrinks, previously added `mcp__waypost__*` grants remain auto-approved instead of being reconciled.

2. **Preserve the existing Codex configuration mode.** Replacing a `config.toml` originally created with mode `0600` through a default-umask temporary file can change it to `0644`, potentially exposing MCP environment variables or other local secrets.

3. **Do not extend inline TOML tables.** Appending `[mcp_servers.waypost.tools.*]` tables to a Waypost section containing `tools = {}` creates invalid TOML because inline tables cannot be extended. The initializer must parse or reject unsupported shapes rather than corrupt the file.

4. **Fail closed on Thurbox lookup errors.** The current JSON command helper collapses nonzero exits, empty output, and malformed JSON into `null`, which can turn database or CLI failures into a false `not_found` result. In addition, `thurbox-cli session get` accepts UUIDs, so title/default references cannot be assumed to work as lookup identifiers.

5. **Retain the task lock until session cleanup finishes.** Releasing active-task locks before deleting task sessions permits a workspace to be reassigned while a prior coder or reviewer session may still be live after a guarded or failed deletion.

6. **Launch Windows provider shims through `ComSpec`.** npm/global `.cmd` and `.bat` shims cannot be launched portably with the current direct `spawnSync` path. The session deletion interface therefore fails for normal Windows provider installations.

## P2

7. **Honor `CODEX_HOME` when selecting `config.toml`.** The permission initializer currently targets `$HOME/.codex/config.toml` even when Codex is configured to use another home.

8. **Read Thurbox's actual ownership fields.** Thurbox v1.7.1 reports the effective work directory as `cwd` and the parent as `parent_session_id`; reading unrelated top-level keys produces incomplete audit metadata.

9. **Make the new workflow fixtures Windows-compatible.** The fake provider executables used by the new integration tests are extensionless POSIX scripts. They need Windows command companions or explicit platform scoping.

## Resolved During Follow-up

10. **Resolved: read Agent Deck runtime data through its XDG layout.** The cleanup script now selects one effective Agent Deck data root, preferring `$XDG_DATA_HOME/agent-deck` (or `~/.local/share/agent-deck`) and falling back to `~/.agent-deck` only when the XDG root is absent. State-database and hook lookups use that same root, so stale legacy metadata cannot be mixed with an active XDG installation. A regression test verifies that XDG provider IDs win even when a conflicting legacy hook exists.
