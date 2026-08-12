# Design Workflow Closeout

The requester that receives the terminal delivery or review report owns successful closeout. Run cleanup only after the accepted design is authoritative: after the archive commit for draft-review, or after the accepted design branch merge for review-existing. Never clean up while revision, decision, commit, merge, or conflict work remains.

Use exact recorded real IDs and the shared host-neutral cleanup entry point.

For draft-review:

```bash
agentgear run multi-agent-protocol archive-and-remove-task-sessions.mjs \
  --task-id <task_id> \
  --owner-session-id <requester_session_id> \
  --session-host <session_host> \
  --artifact-root .agent-artifacts/design-spec-closeout \
  --target architect-author=<author_session_id> \
  --target architect-reviewer=<reviewer_session_id> \
  --apply
```

For review-existing, use one target: `--target architect=<reviewer_session_id>`.

Run cleanup once. Deleted or already absent targets are complete. Preserve and report non-disposable sessions and unsupported hosts. On guard or deletion failure, report cleanup pending with the generated archive and exact manual unblock step; do not retry automatically or reopen review.

Report final design paths, authoritative commit, and cleanup status. Include the cleanup archive and manual unblock step only when cleanup remains pending.
