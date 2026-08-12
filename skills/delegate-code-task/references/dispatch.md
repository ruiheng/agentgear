---
skill-selector: dispatch
selector-summary: Dispatch a persistent code task to its coder.
---

## Dispatch

For `temporary; cleanup=planner`, require `task_dir` and `worker_workspace` to resolve to the same path before dispatch.

1. Prepare workspace records:

   ```bash
   agentgear run multi-agent-protocol prepare-workspaces.mjs \
     --worker-workspace "<worker_workspace>" \
     --planner-workspace "<planner_workspace>" \
     --integration-branch "<integration_branch>" \
     --planner-session-id "<planner_session_id>"
   ```

   Stop on workspace or integration-branch mismatch. Use `--override-workspaces` only after explicit user confirmation.

2. Resolve the coder id/ref through `agentgear skill get multi-agent-protocol session-host`. When review is required, also resolve or create the reviewer before coder dispatch with the same planner parent, workspace, and session host.

   - reuse a found coder with `session_require` and its returned host, real id,
     path, and address;
   - otherwise resolve role `coder`, then create `<coder_session_ref>` with
     its selected opaque launch candidate and recorded planner parent.
     `session_create` verifies that parent; do not preflight it with
     `session_require`.

   Record each returned host, real id, and sole address. Required review must
   have a real reviewer id and address before the wrapper runs.

3. Send the canonical brief through the lock-owning wrapper. It publishes the planner task contract to reviewer first, then dispatches coder only after reviewer delivery returns an id:

   ```bash
   agentgear run multi-agent-protocol send-delegate-with-active-task-lock.mjs \
     --workdir "<worker_workspace>" \
     --task-id "<task_id>" \
     --start-branch "<start_branch>" \
     --integration-branch "<integration_branch>" \
     --task-branch "<task_branch>" \
     --planner-session-id "<planner_session_id>" \
     --coder-session-id "<coder_session_id>" \
     --coder-session-ref "<coder_session_ref>" \
     --session-host "<session_host>" \
     --planner-workspace "<planner_workspace>" \
     --worker-workspace "<worker_workspace>" \
     --task-dir "<task_dir>" \
     --workspace-lifecycle "<workspace_lifecycle>" \
     --session-reason "<session_reason>" \
     --from-address "<waypost_status.default_sender>" \
     --to-address "<coder returned address>" \
     --subject "delegate code: <task_id> -> coder" \
     --brief-file "<brief_file>" \
     --review-context "required" \
     --workflow-policy "<resolved_policy>" \
     --reviewer-session-id "<reviewer_session_id>" \
     --reviewer-session-ref "<reviewer_session_ref>" \
     --reviewer-to-address "<reviewer returned address>" \
     --reviewer-subject "task context: <task_id> -> reviewer" \
     --json
   ```

   For skipped review, set `--review-context "skip"` and omit the four
   `--reviewer-*` options.

   Run this wrapper with host permission. Report success only with a delivery
   id and a `sent` lock. Required review succeeds only with reviewer-context
   and coder delivery ids. The wrapper requests an immediate best-effort wake
   through `waypost send --notify --json` for each durable send and records the
   returned notify status. A failed or unverified wake does not reverse the
   delivery; report it and do not resend or repair the target automatically.
   The wrapper does not impose an outer send timeout by default because Waypost
   persists the delivery before finishing its synchronous notify result. Use
   `--send-timeout-ms` only as an explicit diagnostic override; an interruption
   makes the delivery receipt unknown.

The wrapper owns active-task lock acquisition, reviewer-first ordering, and both sends. Do not split or duplicate those operations. If reviewer delivery succeeds but coder delivery fails, or either delivery is unknown, it retains the lock with the partial result. Surface that state; do not retry automatically.

After dispatch:

- follow the shared Async sender rule
- treat the worker worktree as coder-owned until closeout, even when planner and worker paths are equal
- successful planner closeout removes this task-scoped coder when the host cleanup adapter verifies it as disposable; explicitly reusable or guard-blocked sessions are preserved and reported
- keep any reviewer under the planner parent and in the same worker workspace
- planner attempts recorded temporary-worktree cleanup after closeout and reports `cleanup=complete` or `cleanup=pending`; neither changes delivery completion
