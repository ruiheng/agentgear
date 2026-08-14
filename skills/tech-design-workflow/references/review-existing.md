---
skill-selector: review-existing
selector-summary: Review already committed design specifications on a recorded branch.
---

# Review Existing Specifications

Require committed docs, `design_spec_branch`, `design_spec_base_branch`, complete requester context, and an explicit `design_specs_in_scope`. Never guess the base.

Resolve the reviewer ID and host from explicit input, workflow context, and persisted Waypost history, then call `session_require` with its id or ref and reviewer workspace. If prior review context exists but identity or host is missing, stop rather than create a context-free replacement. Create a reviewer only after `status = not_found` for a clearly new lane, following the host-neutral launch contract.

Before each request:

1. Resolve `reviewed_commit = git rev-parse <design_spec_branch>`.
2. Inspect `git diff --no-renames --name-only <design_spec_base_branch>...<reviewed_commit>`.
3. Require every changed path to be covered by `design_specs_in_scope` and stop if implementation or unrelated paths appear.

Send this target from the requester to the reviewer. On the first request, include the complete requester-authored Canonical Design Task Contract inline. On later rounds, include any requester Decision Delta and the previous reviewed commit.

```markdown
Task: <task_id>
Action: design_spec_review_requested
From: <requester_role> <requester_session_id>
To: architect_reviewer <reviewer_session_id>
Session Host: <session_host>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Requester Context
- Source: inline requester Design Task Contract

# Design Task Contract
[First request only]

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
