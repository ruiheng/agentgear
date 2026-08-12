---
skill-selector: draft-review
selector-summary: Start a new draft-round technical design review.
---

# Draft-Review Start

## Inputs and Round

Resolve requester identity from explicit input, then current session context. Require task ID, problem/goals/constraints, archive branch, and optional known context/open questions/focus. Resolve the round from explicit input or inbound message, then persisted lane context; use 1 only for a clearly new lane.

Resolve archive branch from explicit input, or the current branch only when it is clearly the formal-doc landing branch. Stop on detached HEAD or ambiguity.

For author and reviewer, independently resolve tool selection with roles `architect_author` and `architect_reviewer`, passing the target workdir. Record opaque selected candidates in lane context; do not put commands or provider keys in messages.

## Sessions

Retrieve `agentgear skill get multi-agent-protocol session-host tool-resolution` before session operations.

Resolve deterministic refs, defaulting to `architect-author-<task_id>` and `architect-reviewer-<task_id>`:

- if found, verify returned path and call `session_require` with returned host, real ID, and expected workdir;
- if not found, call `session_create` with the deterministic ref, requester parent, and resolved opaque candidate.

Require distinct real IDs, one shared returned host, and one address per target. After interrupted setup, resolve first and never create a target that already resolves. After review history exists, recover missing real IDs from Waypost history or stop.

## Contract and Dispatch

Write one Canonical Design Task Contract under `.agent-artifacts/message/`. Preserve Original Request separately from requester normalization.

Dispatch it unchanged to reviewer first and author second:

```bash
agentgear run tech-design-workflow send-design-draft-with-review-context.mjs \
  --workdir "<current workspace>" \
  --task-id "<task_id>" \
  --requester-role "<requester_role>" \
  --requester-session-id "<requester_session_id>" \
  --author-session-id "<author_session_id>" \
  --reviewer-session-id "<reviewer_session_id>" \
  --session-host "<session_host>" \
  --round "<round>" \
  --max-review-rounds "<max_review_rounds>" \
  --artifact-path ".agent-artifacts/design-spec/<author_session_id>/rNNN.md" \
  --archive-branch "<archive_branch>" \
  --from-address "<waypost_status.default_sender>" \
  --author-to-address "<author address>" \
  --reviewer-to-address "<reviewer address>" \
  --contract-file "<canonical contract file>" \
  --json
```

Run with host permission. The wrapper owns reviewer-first ordering, both sends, and retained dispatch state; do not split or duplicate them. Report success only for state `sent` with both delivery IDs. Surface partial or unknown delivery state and do not retry automatically. Then follow the shared Async sender rule.
