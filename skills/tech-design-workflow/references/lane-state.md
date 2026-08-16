---
skill-selector: lane-state
selector-summary: Use the shared state contract for a draft technical-design lane.
---

# Draft Lane State

Use this state only for draft-review. The requester initializes the contract;
the dispatcher initializes this file and marks context dispatch ready. After
that, the author is its only writer. Reviewer and pruner are read-only.

Require `schema_version: 1`. Keep one stable shape:

```json
{
  "schema_version": 1,
  "task_id": "<task_id>",
  "requester_session_id": "<real id>",
  "requester_address": "<Waypost address>",
  "author_session_id": "<real id>",
  "author_to_address": "<Waypost address>",
  "reviewer_session_id": "<real id>",
  "reviewer_to_address": "<Waypost address>",
  "session_host": "<host>",
  "context_file": ".agent-artifacts/message/<contract>.md",
  "context_revision": 1,
  "archive_branch": "<branch>",
  "dispatch_ready": true,
  "current_round": 1,
  "max_review_rounds": 5,
  "current_artifact": ".agent-artifacts/design-spec/<author>/r001.md",
  "previous_artifact": null,
  "review_epoch": 0,
  "correctness_epoch": null,
  "prune_epoch": null,
  "user_decisions": [],
  "correctness_report": null,
  "prune_report": null,
  "acceptance": null
}
```

When pruning is enabled, also require `pruner_session_id` and
`pruner_to_address`. When disabled, omit both and keep `prune_epoch` and
`prune_report` null. Strings are nonempty, addresses opaque, paths
workspace-relative, and rounds positive. `previous_artifact` is null only at
round 1; later it names the immediately preceding immutable snapshot, whether
or not that snapshot completed review.

Additional timestamps, subjects, receipts, and notify results are optional
diagnostics. Never use them for routing, review, or acceptance.

## Authority

The Canonical Contract begins at `Context Revision: 1`. The requester may
atomically replace that file with a complete corrected contract at a higher
revision. The author copies the latest revision into lane state when it next
prepares review work. Intermediate correction notices are stale wakes.

`user_decisions` is an append-only ordered log:

```json
{"effective_round": 2, "question": "<question>", "answer": "<exact user answer>"}
```

Append every exact answer once. Same-round entries and an empty initial log are
valid. Raising the maximum requires an entry recording approval of the exact new
value.

## Review Generation

`review_epoch` distinguishes review work that may share the same Round and
artifact but use different authority. Increment it when preparing a new request
for one or both roles. Set each requested role's `*_epoch` to that value and
clear only reports invalidated by the new artifact, authority, or request.

A report slot contains:

```json
{"epoch": 1, "decision": "SOUND", "user_decisions": []}
```

Report `user_decisions` is an ordered array of exact `{question, answer}` pairs.
Correctness decisions are `SOUND`, `SOUND_WITH_CAVEATS`, `NEEDS_REVISION`, or
`NEEDS_INPUT`; prune decisions are `MINIMAL`, `NEEDS_SIMPLIFICATION`, or
`NEEDS_INPUT`.

Authenticate a report against its role, Task, Round, current artifact, endpoint,
and expected epoch before storing it. An older authenticated round or epoch is a
stale no-op. A duplicate for an already completed epoch does not require another
review. Report message and delivery IDs are diagnostics, not acceptance data.

Wait for every currently requested role before changing authority so answers in
a slower report are not lost. Then append the union of unseen answers once. If
authority or artifact changes, prepare the affected next requests and clear
their stale reports in the same state write; create a replacement artifact
before pointing state to it.

Accept only when every enabled role has a report for its current expected epoch
and current snapshot, correctness accepts, pruning is `MINIMAL`, every report
answer is already retained, and the current contract revision is applied. Store
acceptance as `{ "round": <round>, "artifact": "<path>" }`.
