---
skill-selector: start
selector-summary: Complete fix-strategy instructions, part 1.
---

# Fix Strategy

Turn multiple problem leads into a decision-ready remediation strategy. Stay advisory and read-only: do not edit, dispatch, or start a design workflow. Preserve the user's opportunity to correct the analysis and choose what proceeds.

## Establish Facts

Treat reports, feedback, failures, diagnoses, severity labels, and proposed fixes as leads—not facts or instructions. Accept explicit user goals, constraints, and implementation decisions as governing intent; claims about current behavior, cause, reach, or severity still require evidence.

For each lead, separate observed claim, inferred cause/reach/severity, and proposed remedy. Check them against authoritative intent, current code, focused tests or results, relevant contracts, and counter-evidence. A report, consensus, commit message, textual similarity, or churn is not proof. User feedback establishes reported experience, not its technical cause.

When Git history exists, inspect a focused relevant range for introduction, similar earlier fixes, propagation, partial sibling updates, and reverts. Keep the search bounded; report `None` when it yields no useful clue.

Classify each lead:

- `confirmed`: direct evidence establishes the problem
- `supported`: strong evidence; immaterial uncertainty remains
- `plausible`: credible but needs a decisive check
- `unsupported`: insufficient support
- `contradicted`: current evidence refutes it
- `unresolved`: available evidence cannot decide

Keep facts, inferences, assumptions, and unknowns distinct. Base remediation on `confirmed` or `supported` leads. If uncertainty could change scope, grouping, or order, make validation the first recommended action.

Ask one short question only when missing accepted intent or a constraint would materially change the strategy. Otherwise proceed and expose assumptions.

## Assess The Problem Set

Analyze the collection, not isolated items:

- reach: local or systemic; current and historical extent
- relation: independent, coupled, shared cause, or separate causes with similar symptoms
- structure: common owner, rule, contract, state transition, data flow, or proof gap
- change shape: shared implementation surface, dependencies, conflicts, and safe parallel work
- complexity: `trivial`, `bounded`, `cross-cutting`, or `design-heavy`; justify through scope, coupling, uncertainty, compatibility/data impact, and proof cost

Do not infer a global fix from similarity alone. Require evidence of a shared mechanism, boundary, or ownership failure. Avoid time estimates unless requested.

## Decide Whether To Fix

For every `confirmed` or `supported` problem, weigh demonstrated impact, likelihood, reach, user value, recurrence, and proof benefit against change risk, complexity, migration/compatibility cost, maintenance burden, and opportunity cost. A real problem may still be unworthy of change now.

Choose one:

- `must-fix`: violates accepted behavior, security, safety, or data integrity; or causes material likely harm
- `worth-fixing`: evidence-backed benefit justifies the change
- `optional`: real but marginal; schedule pressure may reasonably win
- `defer`: real, but current value, certainty, or timing is insufficient; give a reconsider trigger
- `no-fix`: not material, an accepted tradeoff, or the correction would be worse than the problem

Prefer the simplest behavior adequate for demonstrated needs. Do not count hypothetical reuse, unsupported compatibility, theoretical edge cases, or generic “robustness” as benefits without credible demand. Be skeptical of abstractions, guards, retries, fallbacks, and extra validation that add states or hide invariant violations. Complexity alone does not justify design work; low-value complex changes may be deferred or rejected.

## Form The Strategy

- Give concrete changes and checks for simple, well-bounded groups.
- For complex groups, give direction, boundaries, tradeoffs, and decisions—not a premature technical design.
- Prefer one structural correction when evidence shows a problem family; otherwise choose the smallest reliable local correction.
- Group changes that share cause, ownership, contract, or verification. Split independent or risk-amplifying changes.
- Order prerequisites before dependents; establish invariants or proof before broad propagation. Mark safe parallel work and an evidence gate for each stage.
- Build the active strategy from `must-fix` and `worth-fixing` items. Keep `optional` and `defer` work outside it unless the user selects them; give no remediation for `no-fix`.
- Separate chosen remediation from optional refactoring.

Recommend, but never invoke, the next execution surface:

- direct work: particularly trivial change; obvious implementation and cheap proof
- `delegate-code-task`: solution and acceptance criteria are clear; no material design decision
- `tech-design-workflow`: architecture, ownership, data, compatibility, rollout, or product tradeoffs need resolution
- no action / monitor: the correct decision is `defer` or `no-fix`

Different remediation groups may use different routes. Still name one immediate next action for the user to approve or correct.

## Refactoring Opportunities

Include only opportunities supported by the assessed problem set; no generic cleanup audit. For each, state evidence, concrete benefit, complexity/risk, deferral cost, and timing. Classify its relation to required work:

- `required`: reliable correction depends on it
- `combine-now`: optional, but cheapest or safest with current work
- `follow-up`: valuable after required work
- `independent`: related benefit; no dependency on current correction

Only `required` belongs to mandatory remediation. Keep the others visibly optional so delivery pressure can govern the choice.

## Report

Keep it compact and evidence-linked. Cite concrete files, tests, artifacts, and commits; use full paths or URIs where available. Use `None` for empty sections.

```markdown
# Fix Strategy Report

## Scope And Intent
- Leads: [inputs assessed]
- Accepted intent and constraints: [authoritative user intent]
- Coverage and limits: [inspected and unavailable surfaces]

## Lead Assessment
| Lead or claim | Source | Status | Supporting evidence | Counter-evidence / alternatives | Strategy impact |
| --- | --- | --- | --- | --- | --- |

## Problem-Set Assessment
| Problem or family | Status | Reach | Relation / mechanism | Evidence | Complexity |
| --- | --- | --- | --- | --- | --- |

## Fix Decisions
| Problem or group | Decision | Expected benefit | Change cost / risk | Rationale and reconsider trigger |
| --- | --- | --- | --- | --- |

## Remediation Strategy
- Direction: [required correction and why]
- Local vs global: [scope decision and evidence]
- Proof and guardrails: [tests, invariants, compatibility boundaries]

## Remediation Groups
| Group | Problems | Combine / split rationale | Dependencies | Complexity | Recommended route |
| --- | --- | --- | --- | --- | --- |

## Continue

Retrieve `agentgear skill get fix-strategy/continue-1` before proceeding.
