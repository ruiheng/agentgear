# Harness Support

The installer can place the common Agent Skills payload in the native skill
directories for Codex, Claude Code, Gemini CLI, OpenCode, Antigravity, and Kiro.

The installer places skills only. It does not silently write host hooks, MCP
configuration, or permission rules. For an Agent Deck installation, the
workflow pack exposes the explicit opt-in
`agent-deck-workflow-init-permissions` helper; it writes rules through the
stable `agentgear run …` launcher rather than a checkout path. Thurbox users do
not need that Agent Deck-specific helper. The installer intentionally never
edits a harness MCP declaration. Thurbox users maintain their own resolver
candidate keys in Agentgear's local tool-profile configuration and can verify
them with `agentgear run multi-agent-protocol resolve-tool-command.js --check-config`.

The `workflow` and `browser` packs have runtime prerequisites. Run
`agentgear doctor --pack workflow` or `agentgear doctor --pack browser`
before relying on them.
