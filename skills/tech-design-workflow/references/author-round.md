---
skill-selector: author-round
selector-summary: Draft or revise one immutable technical design round and request review.
selector-aliases: action:design_spec_draft_requested, action:design_spec_context_corrected
---

# Author Round

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate the requester/author transport endpoints and Task against the lane
manifest. Read the requester-owned Canonical Contract. A corrected-context
notice names its new positive Context Revision; an older authenticated notice is
a stale wake. Duplicate work is recognizable from the existing artifact and
retained conversation; do not maintain a separate progress database.

## Draft

For round 1, inspect the repository as needed. Later rounds start from the
immediately preceding immutable artifact, reviewer/pruner reports, and their
ordinary diff while rechecking affected evidence. Write the smallest complete,
implementation-ready design at
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`.

Resolve technical questions from the repository, prior artifacts, and the
Canonical Contract. If required user input genuinely blocks drafting, ask the
user directly, carry the exact question and answer in the report, and
have the requester record the confirmed answer in a User Decision Delta. Do not
ask the requester to decide a technical detail. Never edit a round after
dispatch. When a report requires changes, create the next numbered complete
snapshot; the agent knows the active round from its dialogue and artifact
history.

## Review Dispatch

After the artifact is complete, run:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --artifact ".agent-artifacts/design-spec/<author_session_id>/rNNN.md" \
  --previous-artifact ".agent-artifacts/design-spec/<author_session_id>/rMMM.md" \
  --round "<round>" \
  --context-revision "<current contract revision>" \
  --json
```

Omit `--previous-artifact` for round 1. The program reads the layered TOML
policy, measures the artifact, and sends the reviewer request without writing
lane or review state.

`PRUNER_REQUIRED` means no request was sent. Resolve and create the deterministic
`design_pruner` sibling through the Tool Resolution and Session Host contracts,
then rerun with `--pruner-session-id` and `--pruner-to-address`. The request gives
the lazy pruner the manifest, contract revision, and exact artifact it needs.

Receipts are transport diagnostics. After an unclear send, inspect the durable
Waypost result before deciding whether to repeat the same request. Reviewers use
the authenticated message, exact artifact path, Round, and retained context to
recognize stale or duplicate work.

## Reports and Delivery

Authenticate reviewer and optional pruner reports by their actual transport
endpoints, Task, Round, and artifact. Use the reports directly; do not copy them
into the lane manifest. Wait for both reports when a pruner was requested.

Revise on `NEEDS_REVISION` or `NEEDS_SIMPLIFICATION`. If user input is needed,
ask the user directly and wait before revising; carry the exact question and
answer in the resulting report or artifact, then wait for the requester to
record the User Decision Delta. Deliver only after correctness is `SOUND` or
`SOUND_WITH_CAVEATS`, and an enabled pruner reports `MINIMAL`.

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane Manifest: <workspace-relative lane manifest>
Artifact: <accepted artifact>
Round: <accepted round>
Decision: <SOUND | SOUND_WITH_CAVEATS>
[Pruner Session ID: <lazy pruner real id>]

## Caveats
- <exact accepted caveat in artifact order | None>
```

Use `None` for `SOUND`. Include the lazy pruner session ID only when the
requester did not create and record that pruner initially. The requester owns
assessment, archival, and closeout.
