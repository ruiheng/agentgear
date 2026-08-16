---
skill-selector: start
selector-summary: Complete multi-agent-protocol instructions, part 1.
---

# Multi-Agent Protocol

Use this skill as the shared transport, envelope, and lifecycle layer for multi-session work.

Run a bundled workflow script through `agentgear run multi-agent-protocol <script> [args...]`.
The `workflow` pack installer installs that launcher; do not recover the old
installation-specific path from another repository.

## Workflow Order

For any workflow turn:
1. retrieve `agentgear skill get multi-agent-protocol/shared-protocol`
2. use the action skill for the current workflow step
3. use any extra references that skill requires

Interpret references to the shared workflow protocol as:
- use `agentgear skill get multi-agent-protocol` as the entry point
- then follow the returned shared protocol

## Internal Plan Dispatch

When supervisor orchestration assigns one goal to a planner lane, retrieve
`agentgear skill get multi-agent-protocol/internal/dispatch-plan`. This is an
internal protocol selector, not a user- or model-selected skill.

## Session Hosts

Before resolving, creating, requiring, or addressing a collaborator session,
retrieve `agentgear skill get multi-agent-protocol/session-host`. Waypost selects Agent Deck or Thurbox; keep
host detection and provider-specific arguments out of action skills.

## Shared Context

Use the protocol's Multi-Agent Mode Detection and Context Resolution Priority sections.

Treat `waypost_*` names in this workflow as MCP tools, not shell commands; use CLI only for capabilities unavailable through MCP.

## Waypost Host Permission Boundary

Waypost state is host-scoped. Prefer MCP; run Waypost CLI or wrappers with host
permission. If denied, escalate instead of retrying unchanged.

## Launch Resolution

Before creating a new session, retrieve `agentgear skill get multi-agent-protocol/session-host multi-agent-protocol/tool-resolution`. Resolve a workflow role to opaque launch
candidate values; never invent a command line or Thurbox agent key in an
action prompt.

## Error Handling and Diagnostics

Retrieve `agentgear skill get multi-agent-protocol/diagnostics` for the shared diagnostics checklist.
