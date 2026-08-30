---
skill-selector: draft-review
selector-summary: Start a new draft-round technical design review.
---

# Draft-Review Start

## Inputs and Round

Resolve requester identity from explicit input, then current session context. Inputs are task ID, problem/goals/constraints, archive branch, and optional known context/open questions/focus. A new lane starts at round 1; later rounds continue through author/reviewer dialogue and replacement snapshots.

Resolve archive branch from explicit input, or use the current branch when it is clearly the formal-doc landing branch. Ask when detached HEAD or ambiguity prevents a safe choice.

Resolve `pruner_policy` once: explicit `always` creates the pruner now and skips
the initial size threshold; explicit `never` uses no pruner, including at
delivery; otherwise use `auto` and create it lazily at that threshold. After
`MINIMAL`, enabled policies recheck only for author-declared major structural
change, configured cumulative growth, or the exact final artifact.

Resolve `architect_author`, `architect_reviewer`, and an explicitly enabled `design_pruner`
through the shared Tool Resolution Contract with the target workdir. Keep launch
values out of messages.

## Sessions

Retrieve `agentgear skill get multi-agent-protocol/session-host multi-agent-protocol/tool-resolution` before session operations.

Resolve deterministic refs, defaulting to `architect-author-<task_id>`, `architect-reviewer-<task_id>`, and optional `design-pruner-<task_id>`. Require or create each target through the shared Session Host Contract. Participants use distinct IDs and addresses in one host/workdir. After interruption, recover recorded identities from the host or Waypost history before considering a new lane.

## Contract and Dispatch

Write one Canonical Design Task Contract under `.agent-artifacts/message/` with
`Context Revision: 1`. After dispatch, the author records later product or scope
answers at higher revisions. The wrapper creates the lane manifest at
`.agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json`.
Preserve Original Request separately from requester normalization.

Create the manifest and notify the reviewer, then the enabled pruner, then the author:

```bash
agentgear run tech-design-workflow send-design-draft-with-review-context.mjs \
  --workdir "<current workspace>" \
  --task-id "<task_id>" \
  --requester-session-id "<requester_session_id>" \
  --author-session-id "<author_session_id>" \
  --reviewer-session-id "<reviewer_session_id>" \
  --session-host "<session_host>" \
  --review-checkpoint "5" \
  --review-checkpoint-interval "2" \
  --archive-branch "<archive_branch>" \
  --from-address "<waypost_status.default_sender>" \
  --author-to-address "<author address>" \
  --reviewer-to-address "<reviewer address>" \
  --pruner-policy "<auto|always|never>" \
  --contract-file "<canonical contract file>" \
  --json
```

Policy `always` also supplies `--pruner-session-id` and `--pruner-to-address`;
the other policies omit them.

Run with host permission. The wrapper writes the manifest, then sends reviewer
and enabled-pruner context before notifying the author. Within that invocation,
a returned delivery id is final durable success and never causes another Waypost
send. If its nudge failed or is unknown, the wrapper checks that delivery and
sends only the fixed session-host wake notice unless it is already leased or
acknowledged. Failure to read delivery state does not block that one replay. Do
not rerun the wrapper to repair a nudge.
Report delivery ids and nudge outcomes, then follow the Async sender rule.

## Later User Decisions

If the requester receives an exact user-authoritative product or scope change
after dispatch, do not edit the author-owned Canonical Contract. Send the author:

```markdown
Task: <task_id>
Action: design_task_context_revision
Lane Manifest: <workspace-relative lane manifest>

## User Decision Delta
<exact user wording>

## Requester Context
<supporting facts or requested emphasis; omit when empty>
```

Use `Action: generic` for updates that do not request this contract and review
transition.
