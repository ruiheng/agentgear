# Open Review Findings

Status: findings 1-12 and 14 resolved in the working tree; finding 13 rejected by contract

Recorded: 2026-08-09

Scope: uncommitted session-host, permission-initialization, and workflow-closeout changes on `feature/thurbox-session-host`.

The original review findings and severities are retained below for audit history. Findings 1-9 have implementation and regression-test coverage; later follow-up findings record their disposition inline.

## Resolved P1 Review Findings

1. **Revoke stale Claude MCP grants.** Waypost MCP permissions added by `agent-deck-workflow-init-permissions.mjs` are not recorded as initializer-owned permissions. If Waypost later becomes unavailable or untrusted, or the managed tool list shrinks, previously added `mcp__waypost__*` grants remain auto-approved instead of being reconciled.

2. **Preserve the existing Codex configuration mode.** Replacing a `config.toml` originally created with mode `0600` through a default-umask temporary file can change it to `0644`, potentially exposing MCP environment variables or other local secrets.

3. **Do not extend inline TOML tables.** Appending `[mcp_servers.waypost.tools.*]` tables to a Waypost section containing `tools = {}` creates invalid TOML because inline tables cannot be extended. The initializer must parse or reject unsupported shapes rather than corrupt the file.

4. **Fail closed on Thurbox lookup errors.** The current JSON command helper collapses nonzero exits, empty output, and malformed JSON into `null`, which can turn database or CLI failures into a false `not_found` result. In addition, `thurbox-cli session get` accepts UUIDs, so title/default references cannot be assumed to work as lookup identifiers.

5. **Retain the task lock until session cleanup finishes.** Releasing active-task locks before deleting task sessions permits a workspace to be reassigned while a prior coder or reviewer session may still be live after a guarded or failed deletion.

6. **Launch Windows provider shims through `ComSpec`.** npm/global `.cmd` and `.bat` shims cannot be launched portably with the current direct `spawnSync` path. The session deletion interface therefore fails for normal Windows provider installations.

## Resolved P2 Review Findings

7. **Honor `CODEX_HOME` when selecting `config.toml`.** The permission initializer currently targets `$HOME/.codex/config.toml` even when Codex is configured to use another home.

8. **Read Thurbox's actual ownership fields.** Thurbox v1.7.1 reports the effective work directory as `cwd` and the parent as `parent_session_id`; reading unrelated top-level keys produces incomplete audit metadata.

9. **Make the new workflow fixtures Windows-compatible.** The fake provider executables used by the new integration tests are extensionless POSIX scripts. They need Windows command companions or explicit platform scoping.

## Resolved During Follow-up

10. **Resolved: read Agent Deck runtime data through its XDG layout.** The cleanup script now selects one effective Agent Deck data root, preferring `$XDG_DATA_HOME/agent-deck` (or `~/.local/share/agent-deck`) and falling back to `~/.agent-deck` only when the XDG root is absent. State-database and hook lookups use that same root, so stale legacy metadata cannot be mixed with an active XDG installation. A regression test verifies that XDG provider IDs win even when a conflicting legacy hook exists.

11. **Resolved: avoid recloning unchanged upstream skills on every development link.** A default `agentgear-link` reuses the upstream skill from `current` or another recorded release only when that runtime's catalog has the exact same repository, ref, commit, skill path, and catalog-anchored content digest. Modified cached content is rejected. First installation and changed pins still use a fresh verified clone.

12. **Resolved: preserve exact UUID lookup for inactive Thurbox sessions.** `session list` intentionally contains only active sessions. Cleanup now uses that inventory for title resolution, then falls back to `session get <uuid>` only for an exact UUID. A real `Session not found` remains an absent-session result; provider, database, and JSON failures stop cleanup instead of releasing ownership state.

13. **Rejected: retain task locks for explicitly reusable sessions.** This conflicts with the workflow contract: reusable sessions are intentionally preserved after their completed task releases its reservation. Session existence is not task ownership. Guard and deletion failures retain workspace records; a verified non-disposable session remains an optional warning. Replacing this distinction with a permanent lock would make reusable sessions unusable for later tasks.

14. **Resolved: prevent `%VAR%` expansion in Windows provider shims.** `.cmd` and `.bat` providers require `cmd.exe`, where percent expansion occurs even inside quotes. Agentgear now fails closed before invoking the shell when the resolved provider path or an argument contains `%`, preserving the original value rather than executing a transformed command line.

15. **Resolved protocol finding: do not auto-repair an unverified wake.** A captured Agent Deck v1.11.0 send returned the issue-#1793 submission error even though the target Codex session had already received the hint, started processing, and then received duplicate hints. The shared protocol now treats wake status as advisory after durable delivery and forbids resend, Enter injection, restart, inspection, or repair without explicit user authorization for that session.
