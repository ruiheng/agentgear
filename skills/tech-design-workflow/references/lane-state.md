---
skill-selector: lane-state
selector-summary: Use the shared state contract for a draft technical-design lane.
---

# Draft Lane State

Use this state only for draft-review. The requester initializes the contract;
the dispatcher initializes this file and marks context dispatch ready. After
that, the author is its only writer. Reviewer and pruner are read-only.

Require `schema_version: 3`. Keep one stable shape:

```json
{
  "schema_version": 3,
  "task_id": "<task_id>",
  "requester_session_id": "<real id>",
  "requester_address": "<Waypost address>",
  "author_session_id": "<real id>",
  "author_to_address": "<Waypost address>",
  "reviewer_session_id": "<real id>",
  "reviewer_to_address": "<Waypost address>",
  "pruner_policy": "<auto|always|never>",
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
  "review_gate": null,
  "acceptance": null
}
```

For an existing schema-v2 lane, preserve its old pruning behavior: an existing
pruner becomes `always`, and no pruner becomes `never`. The first normal review
dispatch upgrades the state atomically, creates a digest-bound gate and fresh
epoch, and invalidates old reports and acceptance. Verification mode must reject
v2 because its prior review was not bound to an artifact digest.

`always` requires `pruner_session_id` and `pruner_to_address` at lane creation;
`auto` adds them only after a size gate requires lazy activation; `never` omits
them. Without an enabled pruner, keep `prune_epoch` and `prune_report` null.
Once present, pruner identity is immutable. Strings are nonempty, addresses opaque, paths
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

Only `dispatch-design-review.mjs` prepares draft review work. It measures the
complete current artifact using the layered TOML workflow policy before changing
state. If auto policy reaches either configured threshold without a pruner, it
returns `PRUNER_REQUIRED` without writing an epoch or sending a message.

On dispatch, store this gate shape:

```json
{
  "round": 1,
  "artifact": ".agent-artifacts/design-spec/<author>/r001.md",
  "context_revision": 1,
  "user_decision_count": 0,
  "lines": 250,
  "chars": 20000,
  "artifact_sha256": "<64 lowercase hex characters>",
  "max_lines": 250,
  "max_chars": 20000,
  "pruner_required": true
}
```

`lines` counts nonempty physical lines and `chars` counts non-whitespace Unicode
characters. `artifact_sha256` is calculated from the exact artifact bytes by the
dispatch program and binds those bytes to the review epoch. Reaching either
threshold activates auto pruning. `review_epoch`
distinguishes work that may share the same Round and artifact but use different
authority. The dispatch program increments it, assigns each requested role's
`*_epoch`, clears invalidated reports, and clears acceptance atomically with the
gate. A retry reuses a matching gate and epoch.
Once a gate names the current Round and artifact, dispatch rejects any digest
change with `ARTIFACT_CHANGED`; never replace that gate in place. Create the next
Replacement Snapshot and advance Round before dispatching changed bytes.

Before a reviewer or pruner opens the target, before storing a report, and
before acceptance or requester archival, run the same program in verification
mode:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --workdir "<current workspace>" \
  --lane-state ".agent-artifacts/design-spec-dispatch/<task_id>.lock/state.json" \
  --verify-gate \
  --json
```

Require `status: verified`. This mode recalculates SHA-256 without Waypost,
state mutation, or messages. `ARTIFACT_CHANGED` invalidates the reports and
requires a replacement snapshot and fresh dispatch.

The correctness report slot contains:

```json
{"epoch": 1, "artifact_sha256": "<gate digest>", "decision": "SOUND", "caveats": [], "user_decisions": []}
```

The prune report slot omits `caveats`. Report `user_decisions` is an ordered
array of exact `{question, answer}` pairs. Correctness `caveats` is an ordered
array copied exactly from the report. It is nonempty only for
`SOUND_WITH_CAVEATS`; every other correctness decision requires an empty array.
Correctness decisions are `SOUND`, `SOUND_WITH_CAVEATS`, `NEEDS_REVISION`, or
`NEEDS_INPUT`; prune decisions are `MINIMAL`, `NEEDS_SIMPLIFICATION`, or
`NEEDS_INPUT`.

Authenticate a report against its role, Task, Round, current artifact, endpoint,
expected epoch, and matching `review_gate` before storing it. An older authenticated round or epoch is a
stale no-op. A duplicate for an already completed epoch does not require another
review. Report message and delivery IDs are diagnostics, not acceptance data.

Wait for every currently requested role before changing authority so answers in
a slower report are not lost. Then append the union of unseen answers once. If
authority or artifact changes, prepare the affected next requests and clear
their stale reports in the same state write; create a replacement artifact
before pointing state to it.

Accept only when `review_gate` matches the current Round, artifact, Context
Revision, User Decision count, and freshly verified artifact SHA-256; every
enabled role has a report for its current expected epoch and exact gate digest;
correctness accepts; pruning is
`MINIMAL`; every report answer is already retained; and the current contract
revision is applied.
`SOUND` requires no caveats. `SOUND_WITH_CAVEATS` requires a nonempty caveat list
that appears verbatim and in the same order under `## Caveats` in the current
artifact. Store acceptance as
`{ "round": <round>, "artifact": "<path>", "artifact_sha256": "<gate digest>" }`.
