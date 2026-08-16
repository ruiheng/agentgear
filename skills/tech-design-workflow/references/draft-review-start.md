---
skill-selector: draft-review
selector-summary: Start a new draft-round technical design review.
---

# Draft-Review Start

## Inputs and Round

Resolve requester identity from explicit input, then current session context. Require task ID, problem/goals/constraints, archive branch, and optional known context/open questions/focus. A new draft lane always starts at round 1. Continue later rounds only through its persisted lane state and `author-round` Replacement Snapshot; never rerun this dispatcher for them.

Resolve archive branch from explicit input, or the current branch only when it is clearly the formal-doc landing branch. Stop on detached HEAD or ambiguity.

Resolve pruner use once: enable it for multiple material concepts, a new
abstraction or ownership boundary, or extra paths; skip localized single-owner
changes. An explicit user choice wins. Preserve the choice through setup; after
dispatch, the lane state's conditional pruner identity and route are authority.

Resolve `architect_author`, `architect_reviewer`, and enabled `design_pruner`
through the shared Tool Resolution Contract with the target workdir. Keep launch
values out of messages.

## Sessions

Retrieve `agentgear skill get multi-agent-protocol/session-host multi-agent-protocol/tool-resolution` before session operations.

Resolve deterministic refs, defaulting to `architect-author-<task_id>`, `architect-reviewer-<task_id>`, and optional `design-pruner-<task_id>`. Require or create each through the shared Session Host Contract with its expected workdir and selected candidate. Require distinct real IDs, one host, and one address per target. After interrupted setup, require again; after review history exists, recover missing IDs from Waypost history or stop.

## Contract and Dispatch

Write one Canonical Design Task Contract under `.agent-artifacts/message/` with
`Context Revision: 1`. After dispatch, only the requester may publish an
authenticated complete correction in the same file, incrementing that revision
by one and notifying every consumer to reread it. The requester never writes
lane state. Leave the contract unchanged otherwise through closeout. The
dispatch wrapper creates the shared lane state
under `.agent-artifacts/design-spec-dispatch/<task_id>.lock/state.json`,
including participant identities, host, round, maximum, artifact paths, archive
branch, contract path, and User Decisions. Preserve Original Request separately
from requester normalization.

Create the lane state and notify the reviewer, then the enabled pruner, then the author:

```bash
agentgear run tech-design-workflow send-design-draft-with-review-context.mjs \
  --workdir "<current workspace>" \
  --task-id "<task_id>" \
  --requester-role "<requester_role>" \
  --requester-session-id "<requester_session_id>" \
  --author-session-id "<author_session_id>" \
  --reviewer-session-id "<reviewer_session_id>" \
  --session-host "<session_host>" \
  --round "1" \
  --max-review-rounds "<max_review_rounds>" \
  --artifact-path ".agent-artifacts/design-spec/<author_session_id>/r001.md" \
  --archive-branch "<archive_branch>" \
  --from-address "<waypost_status.default_sender>" \
  --author-to-address "<author address>" \
  --reviewer-to-address "<reviewer address>" \
  --contract-file "<canonical contract file>" \
  --json
```

When the pruner is enabled, add `--pruner-session-id "<pruner_session_id>" --pruner-to-address "<pruner address>"`.

Run with host permission. The wrapper initializes the lane, sends reviewer and
enabled-pruner context, marks `dispatch_ready`, then notifies the author. The
same command is safe to rerun after partial failure or lost output: it validates
the existing lane and repeats only idempotent initial notifications; an already
progressed author treats them as stale or duplicate wakes. Do not split the
sequence manually. Report success on `sent`, then follow the Async sender rule.
