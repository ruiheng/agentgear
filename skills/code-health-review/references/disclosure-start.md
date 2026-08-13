---
skill-selector: review
selector-summary: Complete code-health-review instructions, part 1.
selector-aliases: code-health-review/start, action:code_health_review_requested
---

# Code Health Review

Review code with a senior-engineer lens focused on maintainability, reliability, provability, and material simplification.
Prefer structural diagnoses that explain multiple symptoms at once instead of listing isolated cleanup ideas.

This skill is advisory only.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Hard Boundary

- inspect code, history, tests, and surrounding context
- identify systemic design problems, ownership failures, and architectural drift
- recommend high-leverage structural corrections and safe sequencing
- do not edit files
- do not apply patches
- do not implement refactors
- do not produce commit-ready diffs unless the user explicitly asks for them later

## When This Skill Fits

Use this skill when the real question is structural, for example:
- why the same module keeps attracting bugs
- why fixes are slow or non-converging
- why review cycles keep surfacing nearby failures
- why the code is hard to test with confidence
- why correct code is needlessly long, indirect, or over-abstracted

Do not use this skill for:
- a single local bug review with no sign of a broader pattern; use `review-code`
- style-only inconsistency or cleanup with no maintainability or reliability signal
- implementation work that expects code changes in the same turn

## Input

Provide one of:
1. the message body from `code_health_review_requested`
2. direct scope + review goal + known pain signals + constraints

Direct-use mode is valid.
This skill may be run without Waypost message workflow when the user wants an immediate advisory review.

Useful pain signals include:
- repeated bugs in the same area
- slow or non-converging fix/review loops
- high-churn modules
- patch-on-patch code
- duplicated decision logic
- repeated implementation patterns with minor local variations
- correct but needlessly long or indirect code shapes
- weak or vague data contracts
- code that is hard to test with confidence

If history-heavy diagnosis is important, state it explicitly. Otherwise, use git history only when it is likely to change the conclusion.

## Input Completeness Gate

Before reviewing, verify:
- scope is explicit
- review goal is explicit
- known pain signals are explicit or safely inferable
- behavior or compatibility constraints are explicit or safely inferable

If critical context is missing:
- in direct-use mode, ask one short clarification question
- in message mode, continue and mark the missing items in `Scope Gaps`
- if no clarification arrives, continue best-effort and mark the missing assumptions in `Scope Gaps`

When asking a clarification question, prioritize the missing fact that most affects whether the problem is local or systemic, usually:
- how many times this failure or bug shape has appeared
- which files or boundaries were touched by the most recent fixes
- which behavior or compatibility boundary must stay stable

## Inspection Order

1. Frame the system question.
- Answer these before deep inspection:
  - What keeps going wrong?
  - Is the pain local ugliness, weak proof, or structural instability?
  - Is the latest reported issue the real problem or just the latest symptom?
  - If the latest symptom were patched in isolation, where would the same failure likely reappear?
  - Which boundary, ownership rule, or data contract would have to change to reduce this whole bug class?

2. Gather the cheapest high-signal evidence:
- use the Review Lens below to decide what to inspect
- first: current code shape, preserved invariants, and tests or missing tests
- next: repeated decision patterns and repeated implementation shapes hidden behind renamed variables, helper wrappers, or file splits
- then: ownership, data flow, and state transitions
- last: recent local history only when current code does not explain the fragility

3. Form one or two structural hypotheses.
Each hypothesis should explain multiple symptoms, not just the latest report item.

4. Stress-test the hypotheses:
- Can the hypothesis explain bug concentration, slow review convergence, and testing pain at the same time?
- Does the proposed direction remove special cases instead of adding guards?
- Does it reduce future change surface instead of moving complexity around?
- Retrieve `agentgear skill get code-health-review/signals` to check the hypothesis against counter-signals.

5. Produce one prioritized report.
Use `agentgear skill get code-health-review/signals` to classify signals.
Use `agentgear skill get code-health-review/remediation-patterns` to shape recommendations.

## Review Lens

Evaluate code using these lenses:

- ownership: who owns state and who is allowed to change it
- boundaries: whether modules have stable responsibilities and narrow interfaces
- type discipline: whether the data model is explicit, checkable, and hard to misuse
- decision locality: whether business rules live in one place or are re-encoded repeatedly
- duplication pressure: whether the same shape of logic appears in multiple places with cosmetic variation
- code shape: whether a correct implementation is needlessly long, indirect, or over-abstracted for its task
- testability: whether important behavior can be proven with focused tests
- change amplification: whether small changes spread across too many files or branches
- bug concentration: whether certain modules or patterns keep attracting similar failures

Highest-signal patterns under those lenses:

- business rules copied across modules with minor variations
- `dict`-shaped or loosely-typed payloads crossing important boundaries
- modules that both orchestrate workflow and implement business rules
- patch layers that preserve a broken design by adding more branching
- tests that only verify top-level behavior because the internals are too entangled
- state transitions encoded by scattered conditionals instead of a clear model

## Decision Rules

- Verdict guidance:
  - `critical`: structural faults are causing recurring bugs, non-converging fixes, or behavior that cannot be proven cheaply
  - `concerning`: ownership, duplication, or boundary problems are already raising maintenance risk, but the system still works with acceptable proof cost
  - `acceptable`: the code may be locally ugly, but the current structure is stable enough and does not show meaningful systemic risk

## Continue

Retrieve `agentgear skill get code-health-review/continue-1` before proceeding.
