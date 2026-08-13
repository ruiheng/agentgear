---
skill-selector: continue-1
selector-summary: Complete code-health-review instructions, part 2.
---

## Review Principles

- prefer converging evidence across code shape, history, and tests
- do not treat high churn alone as proof; correlate it with bug patterns or duplicated logic
- do not treat the latest issue report as the whole problem definition
- treat repeated nearby fixes as evidence of a wrong boundary, wrong ownership model, or missing structural simplification
- treat a "simple" issue that takes many review rounds as a design smell
- do not infer redesign from aesthetics alone; show how the structure creates maintenance cost or reliability risk
- prefer one structural diagnosis that explains many failures over many local style complaints
- prefer stronger types, explicit schemas, narrower interfaces, and single-point rule ownership
- treat pattern-level repetition as a first-class structural smell even when the text is not copied verbatim
- prefer recommendations that delete repeated code paths and collapse near-duplicate workflows
- treat net code reduction as a meaningful maintainability win when behavior and clarity are preserved
- distinguish material simplification from taste; flag it only when it reduces change or proof surface
- prefer recommendations that make focused regression tests easier to write
- say directly when the code is locally messy but not structurally unhealthy
- mark an area as a hotspot only when churn aligns with repeated bug shape, patch layering, weak proof, or repeated nearby fixes; churn alone is not enough

## Output Format

Message mode uses the full structure below:

```markdown
Task: <task_id_or_N/A>
Action: code_health_review_report
From: code-health-reviewer <code_health_reviewer_session_id_or_N/A>
To: <requester_role_or_user> <requester_session_id_or_N/A>
Planner: <planner_session_id_or_N/A>
Round: <round_or_N/A>

## Code Health Assessment
Verdict: [critical / concerning / acceptable]
Scope: [what was reviewed]
Core diagnosis: [1-2 sentence structural judgment]

## Scope Gaps
- [missing context or `None`]

## Primary Signals
- [Signal]: Evidence | Why it matters
If none, write: `- None.`

## Systemic Findings
- [P1] [Area]: Symptom pattern | Structural diagnosis | Why it hurts maintainability or reliability | Recommended direction
- [P2] [Area]: Symptom pattern | Structural diagnosis | Why it hurts maintainability or reliability | Recommended direction
If none, write: `- None.`

## Simplification Opportunities
- [Area]: Needless shape | Simpler direction | Expected reduction in code or decision surface

## Hotspots
- [Module or boundary]: Why this area keeps attracting churn, bugs, or patch layering
If none, write: `- None.`

## Proof and Testability Gaps
- [Gap]: What cannot currently be proven cheaply | What should change
If none, write: `- None.`

## Suggested Structural Order
1. [First high-leverage correction]
2. [Second safe follow-up]
3. [Optional cleanup after the design issue is fixed]

## Guardrails
- tests or checks that must stay green
- compatibility or behavior boundaries that must remain stable
- rollout cautions if the structural change is broad

## Keep As-Is
- [Area]: Why changing it now is not worth the risk
If none, write: `- None.`

## Open Questions
- [Question]
If none, write: `- None.`
```

Direct-use mode skips the header block and starts at `## Code Health Assessment`.

## References

- Retrieve `agentgear skill get code-health-review/signals` when judging whether a code smell is local or systemic.
- Retrieve `agentgear skill get code-health-review/remediation-patterns` when proposing structural corrections or sequencing.

## Direct-Use Mode

When invoked directly by the user instead of Waypost message workflow:

- skip the message header block
- return the report directly in the conversation

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/session-host` for shared protocol.

Skill-specific context resolution:
- `task_id`: explicit -> message body -> default `N/A`
- `planner_session_id`: explicit -> message body -> default `N/A`
- `code_health_reviewer_session_id`: explicit -> message body `To` header -> bound Waypost sender context -> ask
- `requester_session_id`: explicit -> message body `From` header -> ask
- `requester_role`: explicit -> message body `From` header -> default `requester`
- `round`: explicit -> message body `Round` header -> default `1`

Execution flow in multi-agent mode:
1. review the requested scope
2. produce one advisory `code_health_review_report`
3. use `waypost`
4. first call `session_require` with:
   - `session_id = <requester_session_id>`
   - `workdir = <current workspace>`
   - retain the returned requester Waypost address
5. send the report back with `waypost_send`
   - `from_address = <current bound code-health-reviewer Waypost address>`
   - `to_address = <returned requester Waypost address>`
   - `subject = "code health review report: <task_id> r<round>"`
   - `body = <code health review report body>`
6. do not naturally end after drafting the report; this workflow turn is complete only after the required `waypost_send` back to the requester has succeeded

## Rules

- this skill is review-only
- keep findings concrete and evidence-backed
- name exact modules, boundaries, or repeated patterns
- distinguish structural faults from optional cleanup
- prefer high-leverage conclusions over long laundry lists
- call out pattern duplication directly, not just literal duplication
- do not recommend a design pattern by name unless it clearly reduces complexity here
- tie every recommendation to maintainability, reliability, or testability
- do not turn advisory findings into implementation work inside this skill
