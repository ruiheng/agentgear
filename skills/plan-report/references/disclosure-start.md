---
skill-selector: receive
selector-summary: Complete plan-report instructions, part 1.
selector-aliases: plan-report/start, action:plan_report_delivered
---

# Plan Report

Handle one final planner report from `plan_report_delivered`.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Input

Provide the message body from `plan_report_delivered`.

## Rules

- treat this report as the final summary for that planner lane unless the body says it is blocked
- surface completion status, integration branch, completed tasks, review summary, and open items
- default completed-plan action is: merge the planner integration branch into the current supervisor branch, then report the planner session as provider-managed
- skip supervisor-side integration only when the report is blocked, the report has unresolved open items, the user explicitly requested report-only handling, or a concrete git precondition blocks the merge
- use `git merge` for supervisor-side integration; do not substitute `cherry-pick`, `rebase`, or another git history strategy
- treat the current supervisor worktree branch as the integration target unless explicit user/workflow context says otherwise; if the target branch is unclear or the worktree is dirty, stop and report the blocker
- do not clean up the planner-owned host structure before supervisor-side integration has actually completed
- generic workflow code does not delete sessions or host groups. If the user explicitly wants host cleanup, use a provider-specific operation after reporting successful integration.
- do not ask for another workflow step unless the report explicitly says the plan is blocked, follow-up is required, or a concrete merge/cleanup blocker needs user action
- keep message JSON internal unless the user explicitly asks

## User-Facing Output

- report whether the plan completed or blocked
- include the planner session id
- include the integration branch
- include whether supervisor-side merge ran
- include that planner session cleanup is provider-managed
- include any open items that still need user attention
