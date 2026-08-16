---
skill-selector: review-existing
selector-summary: Review already committed design specifications on a recorded branch.
---

# Review Existing Specifications

Require committed docs, `design_spec_branch`, `design_spec_base_branch`, complete user context, and an explicit `design_specs_in_scope`. Never guess the base.

Resolve one reviewer through the shared Session Host Contract, preserving its
real ID, host, sole address, and expected workspace. Existing review context
requires that recorded identity; never create a context-free replacement.
Create only for a clearly new lane. Retain both transport endpoints for each
sent round so only that reviewer can report to that requester route.

Before each request:

1. Resolve `reviewed_commit = git rev-parse <design_spec_branch>`.
2. Inspect `git diff --no-renames --name-only <design_spec_base_branch>...<reviewed_commit>`.
3. Require every changed path to be covered by `design_specs_in_scope` and stop if implementation or unrelated paths appear.

Send this target from the requester to the reviewer. On the first request,
include the complete requester-authored Canonical Design Task Contract inline.
On later rounds, include the previous reviewed commit and any new User Decision
Delta. Round always identifies the review round; an included delta takes effect
in that round. The initial contract is immutable for this lane. Retain prior
decisions and the initial Max Review Rounds. Change the maximum only when an
exact User Decision Delta approves the new value. Use one request per Task and
Round; Round is the request correlation.

```markdown
Task: <task_id>
Action: design_spec_review_requested
Round: <round>
Max Review Rounds: <max_review_rounds>

## Requester Context
- Source: inline requester Design Task Contract

# Design Task Contract
[First request only]

## User Decision Delta
- Question: <question>
- User Answer: <exact answer>
[Later request only; omit when none]

## Review Target
- Mode: committed-docs
- Base branch: <base branch>
- Branch: <design branch>
- Commit: <reviewed commit>
- Previous reviewed commit: <commit | none for round 1>
- Docs:
  - path/to/doc.md
```

Do not paste the specifications or provide a hand-written diff. The reviewer derives the machine Git diff from the exact commits. Send with subject `design-spec review: <task_id> r<round>` and follow the shared Async sender rule.
