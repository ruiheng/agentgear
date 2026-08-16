---
skill-selector: continue-1
selector-summary: Complete review-closeout instructions, part 2.
---

## Output Template

Start with:

Include the `Coder session` line only when `coder_session_id` is present.

```markdown
Task: <task_id>
Action: closeout_delivered
Planner: <planner_session_id>
Session host: <session_host>
Coder session: <coder_session_id>
Planner workspace: <planner_workspace>
Worker workspace: <worker_workspace>
Task dir: <task_dir>
Workspace lifecycle: <shared; cleanup=none | temporary; cleanup=planner>
Round: final
Accepted Review By: reviewer <reviewer_session_id>

### Review Closeout
```

Append the required recorded plan:

```markdown
#### Recorded Branch Plan
- Start branch: [start_branch]
- Integration branch: [integration_branch]
- Task branch: [task_branch]
- Rule: use this recorded branch plan as the authoritative merge target; do not substitute `main`/`master`/current branch unless the user explicitly changed the plan
```

Append only relevant non-empty sections:

```markdown
#### Residual Follow-up For Planner
- Track in progress/todo: [items worth recording for later follow-up, or `None`]
- Consider as next task/subtask: [items worth queueing, or `None`]
- No extra tracking needed: [items intentionally left as informational only, or `None`]

#### User Decision Summary
[all task-scope user decisions from the accepted review; only when present]

#### UI Manual Confirmation Package
- UI impact: [detected | none detected]
- Changed UI surfaces: [routes/pages/components]
- Manual check steps (human-run): [short checklist]
- Expected visible outcomes: [what user should see]
- Notes: [optional]
```

## Guidelines

1. Prefer completeness over aggressive trimming
2. Keep neutral tone
3. Include only FAIL/UNKNOWN check lines
4. Keep section order stable
5. Keep output compact and copy/paste friendly
6. Preserve `workflow_policy` unchanged when sending
7. Preserve `special_requirements` unchanged when sending
8. Make deferred follow-up ownership explicit enough that planner can act without rereading the whole report in the common case
9. Do not naturally end after drafting the closeout text; this workflow turn is complete only after the required local continuation or `waypost_send` delivery step has succeeded
