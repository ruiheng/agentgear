---
skill-selector: start
selector-summary: Choose and start sequence or roundtable intent framing.
---

# Intent Framing

Clarify what the user is really trying to achieve before acting on the underlying task.

Choose from explicit input; ask only when unclear:

- `sequence`: user-selected framers contribute in order and may talk directly with the user.
- `roundtable`: iterative moderated discussion; use the existing `roundtable` skill.

Each run owns `.agent-artifacts/intent-framing/<flow_id>/`. Initialize it from the original input in one command; the tool never rewrites `input.md`. Later user context is additive. The directory is always deliverable. Stop whenever the user asks.

Use `agentgear run intent-framing flow.mjs` for artifact state. Commands are agent-facing; do not make the user remember or assemble them.

For sequence mode, retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/session-host multi-agent-protocol/tool-resolution intent-framing/sequence`.

For roundtable mode, retrieve `agentgear skill get intent-framing/roundtable`.
