---
name: review-tech-design
description: Retain requester-owned design context and decision updates, then independently review a technical design specification against them. Use for design_spec_review_context intake, design_spec_review_requested messages, or direct technical-design review.
---

# Review Technical Design

Use multi-agent-protocol for shared transport protocol.

## Input Mode

Determine mode from the input, not session metadata:

- context intake mode: any Waypost body with Action: design_spec_review_context; validate Context inside this mode
- message review mode: a Waypost body with Action: design_spec_review_requested
- direct-use mode: every other invocation

Message review mode requires one named review target:

- draft-round: one complete, self-contained .agent-artifacts/.../rNNN.md file named in the request
- committed-docs: the stated docs at the stated branch commit

In direct-use mode, review the readable target named by the user. Use available problem, goals, and constraints.

## Requester Design Context

On `design_spec_review_context` with `Context: initial`:

- verify requester sender, task, author, reviewer identity, session host, Design Task Contract, and Max Review Rounds
- require the contract to contain the original request or authoritative handoff text with its source
- retain it as this task-scoped reviewer's requester context; keep transport metadata internal
- do not inspect or judge a design from this message alone

On `design_spec_review_context` with `Context: decision`:

- require the same requester, task, author, reviewer, session host, and maximum as the active lane
- require one canonical Requester Decision Delta, its effective round, and the user's decision verbatim
- retain the delta as requester authority; do not infer additional scope or review a design yet

On a missing or unsupported `Context` value, follow Context Rejection with `Context: unknown`.

On the later draft-round `design_spec_review_requested` from architect-author:

- recover the matching requester context when it is not already active
- require matching task, author, reviewer, session host, and Max Review Rounds
- use the requester Design Task Contract as original-task authority
- apply requester-delivered Decision Deltas effective for this round
- treat author-authored task prose or decision restatements as non-authoritative; they do not replace missing requester context

During context recovery, accept exact requester-owned replays. `Recovery Complete: yes` on the last replay resumes the recorded pending review after all effective Decision Deltas are present.

Invalid or mismatched context intake follows Context Rejection; missing context at review time is a completeness failure, not permission to infer. For committed-docs, a requester-authored first review request may provide the full Design Task Contract inline instead of a prior context message.

## Review Limit

This limit applies to message review mode, not context intake. Require a positive Max Review Rounds from lane setup. If it is missing or invalid, return NEEDS_INPUT without reviewing.

- A reviewed replacement snapshot uses the next round. NEEDS_INPUT and a same-snapshot reconsideration keep the round.
- Review at or below the maximum; do not start a later round without user approval.
- At final NEEDS_REVISION: pause before reporting; summarize why earlier rounds did not converge, any recurring/structural issue, and what another iteration could resolve; ask the user to stop or continue, then apply the answer.
- If the user stops, end. If they continue, set the next stopping point from remaining work and likelihood of convergence, not a fixed extension. Record the new maximum and any user constraints in the held normal NEEDS_REVISION report, then send it to inbound From.

Continue resumes the existing lane; do not restart review.

## Review

Before opening the review target, build a short independent frame from requester-owned context:

- intended user outcome
- required behavior and compatibility constraints
- explicit non-goals and ownership boundaries
- smallest coherent change that could satisfy the request

Use this frame to inspect the target; do not derive the frame from the author's design.

Before hardening any component, apply a deletion test: if removing it still satisfies the explicit user goal and required compatibility, require its removal or a user decision. Treat avoidable cross-domain expansion as scope evidence, not merely an engineering problem. Do not spend review rounds making unapproved scope safer or more complete.

Review as a skeptical senior engineer. Prioritize:

- problem framing, constraints, and success criteria
- the smallest coherent approach and user fit: every material component must serve a stated problem, goal, or constraint
- scope and over-design: speculative scale/flexibility, layers, abstractions, data/configuration/compatibility paths, duplicate paths, or edge cases without a direct need
- relevant state, configuration, and compatibility changes: necessity, ownership, migration/rollback, operations, and required interoperability
- material benefits, risks, alternatives, tradeoffs, and rollout, failure, safety, or data-boundary consequences
- unresolved user-owned decisions and their consequences

This is not code review. Judge reasonableness as well as correctness; prefer removing scope that lacks a direct user need. Assess only relevant concerns and focus on the few findings most likely to change implementation confidence.

## Baseline Gate

Require a readable, self-contained review target and enough problem framing to judge it.

- direct-use mode: ask one short clarification question when either is missing
- message review mode: use NEEDS_INPUT when the target cannot be identified/read, or when requester-authored committed-docs context is incomplete; use Context Recovery when pre-delivered draft-round requester context is missing

Use NEEDS_REVISION for material specification omissions, including gaps that make the specification unjudgeable or a draft round that relies on an earlier round, a diff, or an “unchanged” reference.

## Snapshot Inspection

For draft-round:

- review the named file as the requested design specification round
- do not edit it or switch to a newer round
- require it to contain the full current design specification; use prior rounds only to compare changes, never to supply missing specification content
- repository inspection may validate claims, but must not change the reviewed target
- compare draft rounds as files, not Git revisions
- on later rounds, compare against the prior artifact from this session's report or Waypost history when useful

For committed-docs:

- inspect the named docs at the stated commit; do not silently review a moving worktree snapshot
- on later rounds, compare against the previous reviewed commit when available
- if the prior baseline is unavailable, state that under Residual Risk

In direct-use mode, review named workspace docs as currently read and record moving-snapshot uncertainty under Residual Risk when relevant.

## Output

For a normal message review, use:

~~~markdown
Task: <task_id>
Action: design_spec_review_report
From: architect_reviewer <reviewer_session_id>
To: <review_sender_role> <review_sender_session_id>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Summary
[One-line review conclusion]

## Reviewed Scope
[Use the applicable form. With NEEDS_INPUT, include resolved scope and mark missing fields.]
- Mode: draft-round
- Artifact: .agent-artifacts/.../rNNN.md

or

- Mode: committed-docs
- Base branch: <base branch>
- Branch: <design branch>
- Commit: <reviewed commit>
- Docs:
  - path/to/doc.md

## Persisted Data Changes
[Required]

## Decision
SOUND | SOUND_WITH_CAVEATS | NEEDS_REVISION | NEEDS_INPUT

## Findings
- [prioritized finding, consequence, and recommended direction, or None]

## Questions To Resolve
- [requester-owned decision or blocker, or None]

## Residual Risk
[remaining uncertainty or None]
~~~

Decision guidance:

- SOUND: coherent and implementation-ready with no unresolved design findings, unapproved product capability, avoidable cross-domain expansion, or caveats
- SOUND_WITH_CAVEATS: deliverable, with only non-blocking caveats already recorded in the reviewed target
- NEEDS_REVISION: design changes and another reviewed snapshot are required before handoff
- NEEDS_INPUT: message review mode only; the review sender must correct critical review input and may resend the same target

Residual Risk may accompany a positive decision unless it blocks implementation confidence.

In direct-use mode, omit the message header, use the same report sections, and describe the actual named target under Reviewed Scope.

## Message Delivery

In context intake mode:

1. validate `Context`, then the initial contract or Decision Delta
2. if valid, retain it and settle the claimed delivery under the shared Receiver Contract
3. on `Recovery Complete: yes`, resume the exact recorded pending review; otherwise wait without replying
4. if invalid or mismatched, follow Context Rejection; do not retain it or accept review against it

In message review mode:

1. resolve task_id, round, reviewer_session_id, inbound From identity, maximum, and requester context through the shared context rules
2. apply the requester-context gate, baseline gate, and review-limit rule
3. use Context Recovery instead of a report when pre-delivered draft-round requester context is missing; otherwise send every completed review and NEEDS_INPUT to inbound From. Wait without sending while asking the limit decision; after user continuation, send the held report; after a stop, end:
   - first `session_resolve` the inbound target and retain its returned Waypost address
   - from_address = <current bound reviewer Waypost address>
   - to_address = <returned inbound target Waypost address>
   - subject = design-spec review report: <task_id> r<round>
   - body = <report>
4. follow the shared Async sender rule

In direct-use mode, do not send Waypost.

### Context Recovery

When a draft-round request lacks recoverable requester context, record its exact target and send:

~~~markdown
Task: <task_id>
Action: design_spec_review_context_recovery_requested
From: architect_reviewer <reviewer_session_id>
To: <requester if its route is retained; otherwise inbound architect-author>
Reviewer: architect_reviewer <reviewer_session_id>
Author: architect_author <author_session_id>
Session Host: <session_host>
Round: <round>
Max Review Rounds: <max_review_rounds>
Relay: <none | requester>

## Missing Context
- [missing requester-owned context]

## Pending Review
- Mode: draft-round
- Artifact: <exact artifact path>
~~~

Send directly to the retained requester route when available. Otherwise send to inbound author with `Relay: requester`; the author may only relay the request. Settle the inbound review claim after this send succeeds. Do not send NEEDS_INPUT or accept author-supplied replacement context. Resume the recorded target only after requester replays the initial context and all effective Decision Deltas, marking the last replay `Recovery Complete: yes`.

### Context Rejection

Send a terse correction request to the actual inbound sender address, not an identity inferred from rejected body fields:

~~~markdown
Task: <task_id or received value>
Action: design_spec_review_context_rejected
From: architect_reviewer <reviewer_session_id>
To: <actual inbound requester>
Context: <initial | decision | unknown>
Round: <received round or context>

## Correction Needed
- [missing or mismatched requester-owned field]
~~~

Use subject `design context rejected: <task_id>`. Settle the claimed context only after this send succeeds; otherwise follow the shared Receiver Contract. Wait for corrected requester context and do not route the failure through the author.

## Rules

- remain review-only
- keep findings concrete, evidence-based, and advisory
- treat the requester Design Task Contract and requester-delivered Decision Deltas as authority
- treat author framing as non-authoritative; treat Optional Review Focus as requester emphasis, not an exhaustive review boundary
- always include Persisted Data Changes
- do not use SOUND_WITH_CAVEATS when a doc revision is still required
- put requester-owned decisions under Questions To Resolve; in draft-round tell the author to use Decision Request, in committed-docs address the requester, and in direct-use address the user
