# Harness Support

The default targets are `general,claude`. `general` installs the common Agent
Skills payload in `~/.agents/skills` or `.agents/skills`, once for every
supported host that discovers that shared layout, including Codex, Gemini CLI,
OpenCode, and Antigravity. Agentgear intentionally does not duplicate those
skills into each host's legacy or host-native directory: Gemini gives
`.agents/skills` precedence, and duplicate names create avoidable ambiguity.

`claude` adds Claude Code's separate `.claude/skills` location. Kiro currently
declares its own `.kiro/skills` location, so it remains the optional `kiro`
target. Use `--target general` or `--target claude` to narrow the default pair;
use `--target general,kiro` when both generic and Kiro locations are needed.

The installer places skills only. It does not silently write host hooks, MCP
configuration, or permission rules. Configure permissions explicitly through
`agentgear permissions init`; user scope is the default, while `--scope
project --project DIR` writes trusted-project configuration. Verify the active
scope with `agentgear permissions check`. Generated rules use the stable
`agentgear run …` launcher rather than a checkout path. The initializer does
not create an MCP server declaration; it adds scoped approvals only when the
Waypost server is already configured. Codex approvals use a bounded generated
block with an adjacent ownership record, so later initialization can revoke
only Agentgear-owned sections when trust changes. Permission writes are rolled
back together if any harness configuration fails. Legacy Codex and Gemini rule
files are moved to an adjacent `.agentgear-backup` file after successful setup,
rather than deleted; unrecognized contents produce a warning but remain fully
recoverable. Thurbox users maintain their own resolver candidate keys in
Agentgear's local tool-profile configuration and can verify them with
`agentgear resolve-tool-command --check-config`.

The permissions command authorizes only the workflow's `agentgear run
multi-agent-protocol …` and `agentgear resolve-tool-command …` forms. It does
not authorize global `install`, `update`, or `uninstall` operations.

The `workflow` and `browser` packs have runtime prerequisites. Run
`agentgear doctor --pack workflow` or `agentgear doctor --pack browser`
before relying on them.
