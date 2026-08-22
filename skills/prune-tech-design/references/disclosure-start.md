---
skill-selector: start
selector-summary: Retain user context and prune an immutable technical-design round.
selector-aliases: action:design_prune_context, action:design_prune_requested
---

# Prune Technical Design

Retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` before Waypost work.

## Mode and Context

`design_prune_context` and `design_prune_requested` use message mode. Every other
invocation is direct-use: review the user-provided design against explicit or
inferable constraints and ask only when a critical constraint is missing.

In message mode retrieve `tech-design-workflow/lane-manifest`. Authenticate Task,
the pruner recipient, and the expected sender against the stable manifest and
the actual Waypost endpoints before acting:

- initial context: requester -> pruner, `Context: initial`, positive Context
  Revision, and no Round;
- prune request: author -> pruner, positive Round, exact Artifact, exact
  immediately preceding Previous Artifact for round 2 or later, and positive
  Context Revision.

Require the requested Context Revision to match the Canonical Contract. Require
the artifact paths to follow the manifest author and immutable round naming.
A lazy pruner may receive its first retained context with the prune request; in
that case read the complete Canonical Contract through the manifest before
reviewing. An authenticated older contract revision or Round is a stale no-op.
Defer missing context and reject a different task, endpoint, future Round, or
invalid target. Do not require or update shared progress state.

Initial context retains the complete Canonical Contract and waits. Missing or
unsupported authenticated context returns `NEEDS_INPUT`; routing errors do not.

## Review

Ask: what can be removed from the design and document while the explicit goal
and required behavior remain clear?

- Test every material component, abstraction, mode, compatibility path, state
  store, configuration surface, and optional capability for deletion.
- Remove repeated rationale, ornamental sections, and detail an implementer can
  safely infer.
- Keep concepts justified by user authority, a hard constraint, or current
  repository fact.
- Recommend only remove, merge, compress, inline, reuse, or defer. Do not invent
  a replacement architecture or reward hypothetical future-proofing.
- Ask the user directly and wait when required user input blocks pruning. Carry
  the exact question and answer under `## User Decisions`; the draft author
  records the confirmed answer in the User Decision Delta.

## Report

In message mode send the complete report to the inbound sender:

```markdown
Task: <task_id>
Action: design_prune_report
Lane Manifest: <workspace-relative lane manifest>
Input Kind: <prune-request | context-initial>
Context Revision: <received revision>
Round: <positive round | context>

## Reviewed Target
- Artifact: <exact path | user-provided design | none for invalid context>
- Previous target: <exact path | none>

## Decision
MINIMAL | NEEDS_SIMPLIFICATION | NEEDS_INPUT

## Findings
- [PRUNE-001] <target>: <prune direction and why required behavior remains intact; for NEEDS_INPUT, the precise correction>

## Necessary Complexity
- <non-obvious component that must remain and the requirement it serves, or None>

## User Decisions
- <exact user-input question and answer, or None>
```

Use `MINIMAL` only when no design or document change is required. Initial-context
rejection uses `Input Kind: context-initial`, `Artifact: none`, and Round
`context`. An author rationale may focus attention but does not limit the review
or create a special finding protocol.

Send valid reports, including the final round, then follow the Async sender rule.
Send initial-context `NEEDS_INPUT` to the manifest author when that route
authenticates; otherwise return it to the inbound requester as a lane-setup
failure.
In direct-use mode omit the envelope through Round, start at `## Reviewed
Target`, return directly, and do not send Waypost.
