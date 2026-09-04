---
skill-selector: review-existing
selector-summary: Review already committed design specifications on a recorded branch.
---

# Review Existing Specifications

Inputs are committed docs, `design_spec_branch`, `design_spec_base_branch`, complete user context, and explicit `design_specs_in_scope`. Ask when the base is unknown.

Resolve one reviewer through the shared Session Host Contract, preserving its
real ID, host, address, and expected workspace. Continue an existing lane with
that reviewer; create a reviewer for a new lane. Retain both transport endpoints
for report authentication.

Before each request:

1. Resolve `reviewed_commit = git rev-parse <design_spec_branch>`.
2. Inspect `git diff --no-renames --name-only <design_spec_base_branch>...<reviewed_commit>`.
3. Confirm that changed paths are covered by `design_specs_in_scope`; resolve implementation or unrelated changes before review.

Send this target from the requester to the reviewer. On the first request,
include the complete requester-authored Canonical Design Task Contract inline.
On later rounds, include the previous reviewed commit and any User Decision
Delta for a product or scope change. Round identifies the review request. The
requester asks the user after round 5 and every 2 rounds thereafter. Continuing
is workflow state, not a delta; retain the reviewer and history.

```markdown
Task: <task_id>
Action: design_spec_review_requested
Round: <round>
Review Checkpoint: <review_checkpoint>

Apply the `route-waypost-action` skill.

## Requester Context
- Source: inline requester Design Task Contract

# Design Task Contract
[First request only]

## User Decision Delta
- Question: <question>
- User Answer: <exact answer>
[Later request only; product/scope changes only]

## Review Target
- Mode: committed-docs
- Base branch: <base branch>
- Branch: <design branch>
- Commit: <reviewed commit>
- Previous reviewed commit: <commit | none for round 1>
- Docs:
  - path/to/doc.md
```

Let the reviewer derive the machine Git diff from exact commits. Send with subject `design-spec review: <task_id> r<round>` and follow the shared Message delivery and continuation rule.
