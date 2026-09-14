---
skill-selector: draft-round-review
selector-summary: Independently review one immutable draft technical design round.
---

# Draft-Round Review

Require one named complete
`.agent-artifacts/design-spec/<author_session_id>/<sNNN|rNNN>.md` target. Do
not edit it or switch to a newer round. Use prior rounds only for
comparison, never to supply missing specification content.

On a two-phase lane the request's `Phase` sets the standard:

- `structure` (`sNNN`): judge the structural specification — boundaries,
  ownership, data flow, lifecycle/rollback boundaries, consumed and exposed
  interfaces. Require it to specify only what the Contract assigns this lane
  and to consume other lanes through interfaces, not by re-specifying their
  internals. Missing structure and internals of other lanes are both blocking.
- `implementation` (`rNNN`): the request names the recorded `Structure`
  document. Judge fidelity to that frozen structure plus implementability:
  every boundary, ownership rule, and interface it fixes must survive intact,
  and the detail must let a coder implement it without observing the workflow.
  An `rNNN` that silently redefines recorded structure is blocking; evidence
  that the structure itself is wrong is a blocking `structural` finding —
  resolved by a structure amendment, not an `rNNN` patch.

Retrieve `agentgear skill get search-files` before locating files or code
across the workspace, and apply its ready-tool guidance.

## Round Review Algorithm

For round 1, perform the full independent repository investigation needed to
judge the target.

For round 2 and later, require the message to name the existing immediately
preceding immutable artifact. Read its ordinary diff to the current target.
When you reviewed that snapshot under the same Context Revision and user
decisions, your prior findings and verified ledger facts stand: map diff
changes to them, reuse unchanged ledger evidence per
`multi-agent-protocol/evidence-ledger`, reinspect affected or contradictory
source, and scan the complete current artifact for consistency. Derive the
review frame again and review the complete target independently only when
authority changed or your records are missing. The diff is navigation, not
approval: a prior Decision does not carry forward; your verified facts do.

A round 2 and later draft-round request carries author notes below the
headers: per-finding dispositions (`accept`/`rebut`/`escalate`) and sometimes
the author's convergence assessment. They are non-authoritative evidence that may focus
attention but does not limit the review — concede a sound rebuttal, or
re-raise the finding with the evidence the rebuttal did not answer.

Expand scope when evidence justifies it, and record why. Ask the user directly
and wait for the answer when required user input cannot be inferred; include the
exact question and answer in the report. Return `NEEDS_INPUT` only when the
review request or required artifact is missing, mismatched, or unreadable.
Use stable finding IDs when helpful.
