# Harness Support

The default targets are `general,gemini,claude`. `general` installs the common
Agent Skills payload in `~/.agents/skills` or `.agents/skills` for Codex and
other hosts that discover that layout. `gemini` installs globally to
`~/.gemini/skills`, the shared global directory loaded by Gemini CLI and Agy;
its project destination remains `.gemini/skills`.

`claude` adds Claude Code's separate `.claude/skills` location. Kiro declares
its own `.kiro/skills` location, so it remains the optional `kiro` target. Use
an explicit `--target` list to narrow the defaults; use `--target general,kiro`
when both generic and Kiro locations are needed.

The installer places skills only. It does not silently write host hooks, MCP
configuration, or permission rules. Configure permissions explicitly through
`agentgear permissions init`; user scope is the default, while `--scope
project --project DIR` writes trusted-project configuration. Verify the active
scope with `agentgear permissions check`. User scope also merges Agy approvals
into `~/.gemini/antigravity-cli/settings.json`; project scope leaves that
global file untouched. Generated rules use the stable
`agentgear run …` launcher rather than a checkout path. The initializer does
not create an MCP server declaration; it adds scoped approvals only when the
Waypost server is already configured. Codex approvals use a bounded generated
block with an adjacent ownership record, so later initialization can revoke
only Agentgear-owned sections when trust changes. Permission writes are rolled
back together if any harness configuration fails. Legacy Codex and Gemini rule
files are moved to an adjacent `.agentgear-backup` file after successful setup,
rather than deleted; unrecognized contents produce a warning but remain fully
recoverable. A Codex Waypost MCP declaration may use the bare `waypost` command
or an absolute command resolving to the already validated Waypost executable.
Thurbox users maintain their own resolver candidate keys in
Agentgear's local tool-profile configuration and can verify them with
`agentgear resolve-tool-command --check-config`.

The permissions command authorizes only the workflow's `agentgear run
multi-agent-protocol …` and `agentgear resolve-tool-command …` forms. It does
not authorize global `install`, `update`, or `uninstall` operations.

The `workflow` and `browser` packs have runtime prerequisites. Run
`agentgear doctor --pack workflow` or `agentgear doctor --pack browser`
before relying on them.
