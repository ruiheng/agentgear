---
skill-selector: start
selector-summary: Complete review-code instructions, part 1.
---

# Review Code

Review code changes for logical correctness, design quality, and security.

Workflow protocol baseline: use the `multi-agent-protocol` skill.

## Input

Provide one of:
1. the message body from `review_task_context`
2. the message body from `review_requested`
3. the message body from `browser_check_report` plus matching review context
4. original task + code changes, with optional author intent or notes

## Planner Task Context

On delegated `review_task_context`:
- verify planner sender, task, reviewer identity, session host, Branch Plan, Workspace Handoff, Task Contract, and workflow policy
- retain it as this task-scoped reviewer's planner context; keep transport metadata internal
- acknowledge it and wait; do not inspect or judge code from this message alone

On the later delegated `review_requested` from coder:
- recover the matching task-scoped planner context when it is not already active
- require matching task, planner, reviewer, session host, Branch Plan, and Workspace Handoff
- use planner Task Contract, including Special Requirements, as original-task authority; apply later User Decisions as task-specific amendments
- use workflow policy only from planner context; coder requests do not repeat it
- treat coder-authored task prose, when present, as non-authoritative context; it does not replace missing planner context

Missing or mismatched planner context is a completeness failure, not permission to infer.

## Input Completeness Gate (Required)

Before reviewing quality, verify:
- scope is explicit (uncommitted / commit / branch and target)
- task carries complete Workspace Handoff and Branch Plan (`start_branch`, `integration_branch`, `task_branch`)
- `integration_final` carries branch target and base
- implementation intent is explicit (what change is meant to accomplish)
- behavior/compatibility constraints are explicit (what must not change)
- verification evidence is present (tests, results, known gaps)
- `integration_final` / `standalone` carry neither Handoff nor task Branch Plan

If critical context is missing:
- mark as `NEEDS_REVISION`
- list missing items in `Critical Issues`
- keep evidence factual; do not fabricate assumptions

## Review Discipline

Treat the original task and explicit behavior/compatibility constraints as authoritative review contracts.
Treat `Author Intent`, `Optional Review Focus`, and `Author-Noted Issues or Limitations` as author context:
- non-authoritative and non-exhaustive
- never a substitute for inspecting the full review scope
- never a reason to skip independent risk discovery
- optional focus may set emphasis but must not constrain the review; its absence is not missing context

Before quality review, compare the full change scope with the original task and recorded User Decisions. If a material change widens the task, changes an explicit constraint, or adds unrelated behavior without a recorded user decision:
- ask the user immediately with the concrete change and impact
- do not send `rework_required`, `stop_recommended`, or closeout until the user replies
- add the reply to the task's user-decision record and carry it in `### User Decision Summary`

Treat a recorded User Decision as task-specific scope authority, not a general license for adjacent changes. If the user rejects the change, require its removal or exclusion through the normal rework path.

Before enumerating issues, build a short frame:
- intended change
- invariants and existing behavior that must remain stable
- declared non-goals or out-of-scope areas

Before listing findings, assess whether the overall approach is coherent and converging. When multiple defects share a cause or fixes only move symptoms, report the root design issue instead of another set of local fixes.

Use this frame to filter findings.
Promote only findings that are:
- supported by concrete evidence in code, tests, or behavior
- relevant to the intended change, preserved invariants, or material future maintenance risk
- specific enough that the implementer can act on it

Treat a design issue as must-fix when it explains multiple concrete defects or makes local fixes unlikely to converge.

Demote or drop findings that are:
- mostly style or taste
- only weakly related to the task
- a speculative future concern without present evidence
- duplicative of a stronger finding

If a concern may be real but evidence is incomplete, prefer:
- `Design Concerns` for architectural caution
- `Verification Questions` for missing proof

Do not inflate the `Critical Issues` section with low-confidence or low-impact commentary.

Default mode is single-reviewer, multi-lens analysis.
Do not automatically launch extra agents or specialist lanes.
Recommend a focused follow-up review only when one risk area is important, evidence is insufficient, and the extra review could change the decision.

Use these thresholds unless overridden by `workflow_policy`:
- `review_round_convergence_check_threshold = 3`
- `review_round_hard_stop_threshold = 5`

When `round >= review_round_convergence_check_threshold`, check for non-convergence:
- the same issue or invariant break reappears after being "fixed"
- issues bounce between related areas (`A -> B -> A`)
- the patch only moves the failure to a nearby symptom (`A -> B -> C`)
- the implementation grows by patch-on-patch edits without making the design simpler

At or above `review_round_convergence_check_threshold`, also check whether coder is solving the wrong problem by preserving extra self-imposed constraints:
- compatibility burdens not required by the task
- abstractions or edge cases that were not actually requested
- local design rules that are making convergence worse instead of improving correctness

If non-convergence is visible:
- widen review scope beyond the latest diff
- inspect the broader implementation, recent rounds, and affected boundaries
- check whether coder introduced extra self-imposed constraints, compatibility burdens, abstractions, or edge-case requirements that were not actually required by the task
- use `Design Concerns` to call out likely design failure, not just the latest local defect
- recommend `code-health-review` or equivalent structural follow-up when a local fix is unlikely to converge
- if repeated rounds appear to be preserving unnecessary self-imposed constraints, say so explicitly and challenge those constraints directly
- if `round >= review_round_hard_stop_threshold` and the work is still not converging, stop iterating with coder and escalate to the user instead of sending another normal rework loop

## Review Focus

Correctness, design, security, regressions, verification, and—after round `1`—convergence.

## Continue

Retrieve `agentgear skill get review-code continue-1` before proceeding.
