# Harness Support

The installer can place the common Agent Skills payload in the native skill
directories for Codex, Claude Code, Gemini CLI, OpenCode, Antigravity, and Kiro.

The installer places skills only. It does not silently write host hooks, MCP
configuration, or permission rules. The workflow pack exposes the explicit,
opt-in `agent-deck-workflow-init-permissions` helper for the latter; it writes
rules through the stable `ai-skills run …` launcher rather than a checkout path.

The `workflow` and `browser` packs have runtime prerequisites. Run
`ai-skills doctor --pack workflow` or `ai-skills doctor --pack browser`
before relying on them.
