---
name: multi-agent-protocol
description: Use the shared protocol for multi-agent collaboration.
---

# Multi-Agent Protocol

Use this skill as the shared transport, envelope, and lifecycle layer for multi-session work.

Run a bundled workflow script through `agentgear run multi-agent-protocol <script> [args...]`.
The `workflow` pack installer installs that launcher; do not recover the old
installation-specific path from another repository.

## Workflow Order

For any workflow turn:
1. follow `references/internal-protocol/shared-protocol.md`
2. use the action skill for the current workflow step
3. use any extra references that skill requires

Interpret references to the shared workflow protocol as:
- use the `multi-agent-protocol` skill as the entry point
- then follow `references/internal-protocol/shared-protocol.md`

## Session Hosts

Before resolving, creating, requiring, or addressing a collaborator session,
use `references/session-host.md`. Waypost selects Agent Deck or Thurbox; keep
host detection and provider-specific arguments out of action skills.

## Shared Context

Use the protocol's Multi-Agent Mode Detection and Context Resolution Priority sections.

Treat `waypost_*` names in this workflow as MCP tools, not shell commands; use CLI only for capabilities unavailable through MCP.

## Tool Resolution

Use `references/tool-resolution.md` for the shared tool-resolution contract before creating a new session.

## Error Handling and Diagnostics

Use `references/diagnostics.md` for the shared diagnostics checklist.
