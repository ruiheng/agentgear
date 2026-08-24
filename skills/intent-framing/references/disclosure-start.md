---
skill-selector: start
selector-summary: Choose and start sequence or roundtable intent framing.
---

# Intent Framing

Clarify or reassess real intent at any stage. Deliver a decision-oriented intent frame suited to the situation—not a mandatory report or checklist.

Choose from explicit input; ask only when unclear:

- `sequence`: user-selected framers contribute in order and may talk directly with the user.
- `roundtable`: iterative moderated discussion; use the existing `roundtable` skill.

Per run: dedicated `.agent-artifacts/intent-framing/<flow_id>/`. Initialize `input.md` from the original request and needed user-authored context, preserving their wording; never substitute coordinator interpretation. Record later context and hypotheses as sourced additions; never rewrite `input.md`. The directory stays deliverable at any stop.

Use `agentgear run intent-framing flow.mjs` for artifact state. Commands are agent-facing; do not make the user remember or assemble them.

For sequence mode, retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/session-host multi-agent-protocol/tool-resolution intent-framing/sequence`.

For roundtable mode, retrieve `agentgear skill get intent-framing/roundtable`.
