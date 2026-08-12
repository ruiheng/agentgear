---
skill-selector: continue-2
selector-summary: Complete review-request instructions, part 3.
---

## Author-Noted Issues or Limitations (Optional)
[Non-exhaustive author notes]
```

For `task` / `integration_final`, insert after `To` in either template:

```markdown
Planner: <planner_session_id>
Planner workspace: <planner_workspace>
```

For `task`, also insert after `Planner`:

```markdown
Session host: <session_host>
```

For task, insert after `Original Task`, or after `Review Context` when delegated task omits Original Task:

```markdown
## Branch Plan
- Start branch: [start_branch]
- Integration branch: [integration_branch]
- Task branch: [task_branch]
- Stability rule: keep this recorded Branch Plan fixed for the dispatch; return requested changes to planner before review

## Workspace Handoff
- Worker workspace: [worker_workspace]
- Task dir: [task_dir]
- Workspace lifecycle: [shared; cleanup=none | temporary; cleanup=planner]
```

Round `>1` to the same reviewer session: send only delta.
Keep the body as short as possible:
- include only sections that changed
- task always repeats Branch Plan and Handoff; other lanes omit unchanged sections
- do not fill the template just because it exists
- `integration_final` / `standalone` may use a one-line body; task keeps its Branch Plan and Handoff

Use this structure. Omit task Branch Plan and Handoff for `integration_final` / `standalone`; task includes both. `standalone` omits planner headers.

```markdown
Task: <task_id>
Action: review_requested
From: <requester_role> <requester_session_id>
To: reviewer {{TO_SESSION_ID}}
Round: <round>

## Summary
[One-line delta summary]

## Delta Since Last Review
- Scope: [what changed in reviewed scope]
- Findings addressed: [adopted items]
- Findings rejected: [rejected items + rationale]
- Author-noted new risks or open questions: [only if changed]

## User Decisions
[user scope decisions made since the last review; only when present]

## Review Context
- Lane: [task | integration_final | standalone]

## Author Update Since Last Review (Optional)
[Non-authoritative intent note for what changed; do not restate the diff]

## Changed Paths Since Last Review
- [count + key paths, or `See scope target` when the git target is enough]

## Checks Already Run Since Last Review
- Lint: [new or rerun command/result or `No change`]
- Build/Link: [new or rerun command/result or `No change`]
- Compile/Type-check: [new or rerun command/result or `No change`]
- Tests: [new or rerun command/result or `No change`]
- Other verification: [new manual/browser/scripted checks or `No change`]
- Coverage gaps: [remaining gaps after this round]

## Author-Noted Issues or Limitations (Optional)
[Current non-exhaustive author notes]
```

For task, insert after `Delta Since Last Review`:

```markdown
## Branch Plan
- Start branch: [start_branch]
- Integration branch: [integration_branch]
- Task branch: [task_branch]

## Workspace Handoff
- Worker workspace: [worker_workspace]
- Task dir: [task_dir]
- Workspace lifecycle: [shared; cleanup=none | temporary; cleanup=planner]
```

## Waypost Message Send + Wakeup

Recommended subject:
- `review request: <task_id> r<round>`

Preferred path: use the `waypost` MCP tools.

Workflow send sequence:
1. use `waypost`
2. compose the body with `{{TO_SESSION_ID}}` where the real reviewer session id must appear
3. delegated task from coder: require the recorded reviewer real id in the recorded workspace and host; stop on missing or mismatch
4. other lanes: choose candidate from known `reviewer_session_id`, otherwise resolve `reviewer_session_ref` with `session_resolve`
5. for other lanes, if a candidate resolves, call `session_require` with its returned host, real id, and `workdir = <current workspace>`
6. for other lanes with no candidate, resolve role `reviewer` through `agentgear skill get multi-agent-protocol tool-resolution`, then call `session_create` for `<reviewer_session_ref>` with the selected opaque launch candidate and the recorded parent: `<planner_session_id>` for planner-owned task / `integration_final` or `<requester_session_id>` for `standalone`. It verifies that parent; do not preflight it with `session_require`.
7. record the returned host, real id, and sole address as the authoritative reviewer route; for a task lane, require that host to match the recorded task session host
8. fill the final body and call `waypost_send` with:
   - `from_address = waypost_status.default_sender`
   - `to_address = <reviewer returned address>`
   - `subject = "review request: <task_id> r<round>"`
   - `body = <review-request message body>`

Rules:
- round `1` sends the full review request in message body
- later rounds to the same reviewer send delta only
- if reviewer continuity changed, resend the full review request body
- include a `Checks Already Run` section so reviewer can reuse coder-run verification instead of rerunning the same slow checks
- for each recorded check, include enough command/result detail to show scope and outcome
- keep tool/model routing internal; use shared tool-resolution policy
- do not duplicate `Checks Already Run` in a separate verification section; record coverage gaps inside `Checks Already Run`
- delegated task reviewer is created by planner dispatch before coder work; create reviewers here only for other lanes
- `waypost_send` may trigger a best-effort non-local reviewer nudge; correctness relies on Waypost message delivery
- follow the shared Async sender rule for the review reply

## Quality Bar

1. Keep concise and copy/paste friendly
2. Keep wording concise and direct
3. Changed paths summary is enough for routing; reviewer should use the git target for exact file details
4. Prefer facts over speculation
5. Keep raw message JSON internal unless user asks
6. Always include `Checks Already Run`; include `Optional Review Focus` only when the requester explicitly provides useful emphasis
7. Delegated coder requests omit `workflow_policy`; other lanes preserve it unchanged when present
8. For delegated coder review, reviewer gets `special_requirements` from planner context; other lanes preserve them unchanged when present
9. Preserve User Decisions unchanged when present
