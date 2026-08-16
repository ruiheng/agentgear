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

In message mode retrieve `tech-design-workflow/lane-state`. Authenticate Task,
pruner recipient, and the expected sender before acting:

- initial context: requester -> pruner, `Context: initial`, positive Context
  Revision, no Round or Review Epoch;
- prune request: author -> pruner, current positive Round and Review Epoch equal
  to `prune_epoch`.

Require the lane's applied Context Revision to match the Canonical Contract and
the requested artifact to be the immutable current target. An authenticated
older revision, Round, or epoch is a stale no-op; a duplicate completed epoch
does not require another review. Defer missing state and reject a different
task, endpoint, future epoch, or target.

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
- Ask the user directly when a product choice blocks pruning.

## Report

In message mode send the complete report to the inbound sender:

```markdown
Task: <task_id>
Action: design_prune_report
Lane State: <workspace-relative lane state file>
Input Kind: <prune-request | context-initial>
Review Epoch: <positive epoch; prune-request only>
Context Revision: <received revision; context-initial only>
Round: <round | context for initial rejection>

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
- <question and exact user answer, or None>
```

Use `MINIMAL` only when no design or document change is required. Initial-context
rejection uses `Input Kind: context-initial`, `Artifact: none`, and Round
`context`. A newer epoch for the same snapshot is an ordinary review against
current authority; an author rationale may focus attention but does not create a
special finding protocol.

Send valid reports, including the final round, then follow the Async sender rule.
In direct-use mode omit the envelope through Round, start at `## Reviewed
Target`, return directly, and do not send Waypost.
