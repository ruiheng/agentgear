---
name: tech-design-workflow
description: Create, independently review, revise, and deliver a coder-facing technical design specification through a multi-agent workflow with requester-owned review context. Use when starting, continuing, or routing this workflow.
---

# Technical Design Workflow

Use multi-agent-protocol for shared transport and session protocol.

## Route First

Route inbound actions before starting a new lane:

- design_spec_draft_requested or design_spec_context_corrected -> Author Execution
- design_spec_review_report -> Report Handling
- design_spec_review_context_recovery_requested -> Author Execution when addressed to architect-author; otherwise Requester Handling
- design_spec_review_context_rejected, design_spec_decision_requested, or design_spec_delivered -> Requester Handling

For a new request, select:

- draft-review when no defensible committed design specification exists or material requirements, interfaces, constraints, or tradeoffs remain unresolved
- review-existing only when the requester already has committed specifications, their branch/base, and enough context to defend them

Do not make the requester invent a specification merely to obtain review.

## Roles

- requester: starts the workflow and owns user-facing handoff
- architect-author: inspects the repository, writes draft rounds, handles reviewer dialogue, and sends the final pointer
- architect-reviewer: independently reviews the requested round without editing it and stops at the review limit

In draft-review, author and reviewer are separate sibling sessions. The requester gives both the same canonical task contract before drafting and sends later user decisions directly to both, reviewer first. The reviewer normally replies to the author; limit decisions are user-gated.

## Canonical Design Task Contract

For draft-review, write one canonical contract under `.agent-artifacts/message/`. The dispatch wrapper embeds it unchanged in both reviewer and author messages. Keep transport, role, artifact, and archive instructions outside the contract.

```markdown
## Original Request
[Preserve the requester's original wording verbatim when available. Otherwise preserve the authoritative handoff text and state its source.]

## Requester Context
- Desired outcome: [normalized outcome]
- Must preserve: [required behavior or boundary]
- Established facts: [facts both architects may rely on]
- Read first: [required repository paths]

## Constraints
- [hard constraint]

## Open Questions
- [architect-owned technical question]

## Optional Review Focus
[explicit emphasis; never a limit on independent review]
```

Omit empty optional sections and lines. Keep `Original Request` distinct from requester normalization. Treat this contract and later requester-delivered Decision Deltas as task authority; the design artifact is a proposal against that authority.

## Dispatched Draft Round Contract

Write rounds under .agent-artifacts/design-spec/<author_session_id>/rNNN.md.

- only the author writes this directory
- r001 is complete; for every later round, copy the preceding file to the next path before editing it. Every delivered round must remain a complete, self-contained design specification, never a delta, diff, or dependency on a prior round
- a round may be edited until its review request is sent; afterward leave it unchanged and write revisions in later numbered rounds
- number revisions monotonically; the named artifact path identifies the round under review
- drafting must not change Git state or workspace ownership

`.agent-artifacts/` is temporary; never add it to Git or write outside the shared workspace.

## Review Limit and User Continuation

Store a positive Max Review Rounds in lane context and carry it across role handoffs; default it to 5 only for a new lane.

A reviewed replacement snapshot uses the next round. NEEDS_INPUT and same-snapshot reconsideration do not advance it.

At the limit, the reviewer asks the user whether to stop or continue. If the user continues, it chooses a suitable next stopping point, returns the normal report with the updated maximum to the existing sender, and that sender resumes the same lane.

## Design Content Gate

Treat each artifact as a coder-facing implementation contract. Resolve the material technical choices Coder would otherwise need to make.

As architect-author, record material conclusions in the artifact for:

- core approach, data structures, interfaces, ownership, boundaries, and a direct user-goal link for every material change
- material algorithms, flows, migration choices, and validation expectations needed for implementation
- simplicity: exclude user-unrequested scope, unnecessary abstraction, speculative flexibility, duplicate paths, and excessive coupling/change surface
- relevant state, configuration, and compatibility changes: necessity, ownership, migration/rollback, operations, and required interoperability
- material benefits, risks, failure handling, alternatives, and tradeoffs
- unresolved user-owned decisions: options and consequences

Treat unrequested product capabilities as out of scope. Existing support, completeness, or future value does not justify inclusion. Exclude any capability that materially expands product scope or crosses ownership domains unless the stated goal requires it or the user explicitly approves it.

Use `Open Questions` only for architect-owned technical decisions. Resolve user-owned product scope before dispatch; if such a decision emerges later, keep it out of the base specification and use Decision Request.

Keep treatment proportional. Cover data, configuration, and compatibility only when relevant; state a no-impact conclusion only when omission would be ambiguous. Do not invent machinery merely to satisfy this gate.

## Start Inputs

Common:

- task_id
- requester session id/role
- recorded session host for every workflow-created architect
- original_request, problem, goals, constraints
- optional known_context, open_questions, feedback_requested, round, max_review_rounds

New architect sessions:

- optional shared architect_tool / architect_tool_profile
- optional architect_author_tool / architect_author_tool_profile
- optional architect_reviewer_tool / architect_reviewer_tool_profile
- resolver roles: architect_author and architect_reviewer
- resolve each target independently: <target>_tool -> architect_tool -> <target>_tool_profile -> architect_tool_profile -> its resolver-role default

draft-review additionally uses:

- archive_branch: explicit -> current branch only when it is clearly the formal-doc landing branch -> ask
- canonical contract file under `.agent-artifacts/message/`
- optional refs; default architect-author-<task_id> and architect-reviewer-<task_id>
- existing real author/reviewer session ids when resuming

review-existing additionally requires:

- design_spec_branch, design_spec_base_branch, committed design_specs_in_scope listing every reviewed doc and design asset
- existing architect_session_id, or optional new architect_session_ref defaulting to architect-<task_id>

## Architect Launch Resolution

Pass the target workdir when resolving:

- author: `--role architect_author`
- reviewer: `--role architect_reviewer`

Do not substitute either role. Record each selected resolver candidate in lane context; do not put its command, Thurbox key, or startup metadata in messages.

## Round Resolution

Resolve round: explicit input or inbound message -> latest persisted workflow context -> 1 only for a clearly new lane.

- use the next round for a revised target after NEEDS_REVISION or a decision/constraint delta
- keep the current round for a NEEDS_INPUT repair or same-snapshot reconsideration; use the next round for a replacement target
- after interruption, resume the valid inbound round and target
- do not infer round solely from filenames or reuse a dispatched file as a revised round; stop on conflicting history

## Draft-Review Start

Resolve requester identity from explicit input, then current session context. Resolve archive_branch by the rule above; stop on detached HEAD or an unclear landing branch.

Resolve both deterministic refs with `session_resolve`. For each target:

- found: verify its returned path, then call `session_require` with its returned host, real id, and expected workdir;
- not found: resolve the target's architect role, then call `session_create` with the deterministic ref, recorded requester parent, and selected opaque launch candidate. It verifies that parent; do not preflight it with `session_require`.

Require distinct author and reviewer real ids and one shared returned host; stop if the ids match or the hosts differ. Record both ids, their host, and sole addresses, and derive the artifact directory from the author id. After interrupted setup, repeat this resolve-first flow; never create a target that resolves. After review history exists, recover missing real ids from Waypost history and stop if recovery fails.

Write the Canonical Design Task Contract once. Send it through the owning wrapper, which delivers reviewer context first and dispatches the author only after the reviewer delivery returns an id:

~~~bash
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
  --artifact-path "<exact .agent-artifacts/design-spec/<author_session_id>/rNNN.md path>" \
  --archive-branch "<archive_branch>" \
  --from-address "<waypost_status.default_sender>" \
  --author-to-address "<author returned address>" \
  --reviewer-to-address "<reviewer returned address>" \
  --contract-file "<canonical contract file>" \
  --json
~~~

Run the wrapper with host permission. It owns reviewer-first ordering, both sends, and retained dispatch state; do not split or duplicate them. Report success only when the state is `sent` with both delivery ids. A failed or unverified wake does not reverse delivery; report it and do not resend or repair a target automatically. If reviewer delivery succeeds but author delivery fails, or either receipt is unknown, surface the retained partial state and do not retry automatically.

After successful dispatch, follow the shared Async sender rule.

## Author Execution

On `design_spec_context_corrected` from the requester, update only the named shared lane fields. Keep the current round and artifact unchanged; do not draft or request review. Authority or design-content changes require `design_spec_draft_requested` and normal Round Resolution instead.

On `design_spec_review_context_recovery_requested` with `Relay: requester`, recover the requester route from lane context. Carry Task, Reviewer, Author, Session Host, Round, and maximum; preserve Missing Context and Pending Review unchanged. Do not supply, reconstruct, or summarize requester context.

On design_spec_draft_requested:

1. recover the requester, reviewer, session host, round, maximum, Design Task Contract, artifact path, and archive branch
2. inspect relevant repository state and user-aligned context
3. write the complete, proportional, implementation-ready design to the named round file, following Dispatched Draft Round Contract and Design Content Gate
4. ensure accepted constraints and rationale live in the artifact, not only in messages
5. send the named artifact to the recorded reviewer, leave it unchanged, then return under the Async sender rule
6. handle later design_spec_review_report deliveries until accepted or a user-owned decision is required
7. after acceptance, send the terse final notification; do not archive or commit the design specification

Do not ask the requester to supply design specification content that repository inspection and engineering judgment can resolve.
Do not resolve user-owned product scope through engineering judgment; exclude optional capability or use Decision Request.
Do not restate the task contract or requester decisions in review requests. The reviewer receives requester authority directly.

Treat a later design_spec_draft_requested as a decision or constraint delta: reuse the lane and create the next numbered round. A continued review arrives as a normal report with its updated maximum.

## Review-Existing Start

Require committed docs, their design branch, and the recorded base branch. Never guess the base.

Resolve the reviewer id and host from explicit input, workflow context, then persisted Waypost history and `session_resolve`. If prior-review context exists but the real id or host remains missing, stop; do not create a context-free replacement. Create a reviewer only for a clearly new lane, using resolver role `architect_reviewer` and the same verified parent/workdir settings as above.

Before each review request, resolve <reviewed_commit> = git rev-parse <design_spec_branch>, then apply the review-existing path gate:

1. inspect git diff --no-renames --name-only <design_spec_base_branch>...<reviewed_commit>
2. require every changed path to be covered by the explicit design_specs_in_scope
3. stop if any implementation or unrelated path appears; branch naming is not proof of scope

## Review Request

Resolve the review sender by lane; that sender owns normal returned reports:

- draft-review: review_sender_role = architect_author, review_sender_session_id = author_session_id
- review-existing: review_sender_role = requester_role, review_sender_session_id = requester_session_id

For each round, send the applicable target form and omit empty optional sections. In draft-review, the reviewer already owns the requester contract and any Decision Deltas; do not repeat or summarize them. In review-existing, the requester includes a full Canonical Design Task Contract inline on the first request.

~~~markdown
Task: <task_id>
Action: design_spec_review_requested
From: <review_sender_role> <review_sender_session_id>
To: architect_reviewer <reviewer_session_id>
Session Host: <session_host>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Requester Context
- Source: <pre-delivered requester contract and Decision Deltas | inline requester Design Task Contract>

# Design Task Contract
[review-existing first request only; omit for draft-review]

## Review Target
[Use exactly one form]
- Mode: draft-round
- Artifact: <named .agent-artifacts/design-spec/<author_session_id>/rNNN.md path>

or

- Mode: committed-docs
- Base branch: <design_spec_base_branch>
- Branch: <design_spec_branch>
- Commit: <reviewed commit>
- Docs:
  - path/to/doc.md

## Optional Review Focus
[review-existing first request only; omit in draft-review because it is already in the requester contract]
~~~

Later rounds use the same envelope and target form, naming the current round's exact artifact or commit. In draft-review, do not carry author-restated requester context; in review-existing, the requester may include its own Decision Delta directly. Author reasoning, changed implementation ideas, and responses to findings belong in the self-contained artifact.

Do not paste or summarize the design specification or a hand-written diff. In draft-review, do not repeat the task contract; in review-existing, include it only in the requester-authored first request as specified above. Send from `waypost_status.default_sender` to the recorded reviewer address with subject `design-spec review: <task_id> r<round>`, then follow the shared Async sender rule.

## User Completion

After the accepted design becomes authoritative, report final design path(s), authoritative commit, and session cleanup status. Include the cleanup archive and manual unblock step only when cleanup is preserved or pending.

## Session Cleanup

The requester that receives the terminal delivery or review report owns successful closeout. Run cleanup only after the accepted design is authoritative: after the archive commit for draft-review, or after the accepted design branch merge for review-existing. Never clean up while a revision, decision, commit, merge, or conflict remains open.

Use exact recorded real ids with the shared host-neutral cleanup entry point. New workflows use repeatable generic targets; do not add role-specific cleanup options.

For draft-review:

~~~bash
agentgear run multi-agent-protocol archive-and-remove-task-sessions.mjs \
  --task-id <task_id> \
  --owner-session-id <requester_session_id> \
  --session-host <session_host> \
  --artifact-root .agent-artifacts/design-spec-closeout \
  --target architect-author=<author_session_id> \
  --target architect-reviewer=<reviewer_session_id> \
  --apply
~~~

For review-existing:

~~~bash
agentgear run multi-agent-protocol archive-and-remove-task-sessions.mjs \
  --task-id <task_id> \
  --owner-session-id <requester_session_id> \
  --session-host <session_host> \
  --artifact-root .agent-artifacts/design-spec-closeout \
  --target architect=<reviewer_session_id> \
  --apply
~~~

Run cleanup once. Deleted or already absent targets are complete. Preserve and report non-disposable sessions and unsupported hosts. On a guard or deletion failure, report cleanup as pending with the generated archive and exact manual unblock step; do not retry automatically, roll back the authoritative design, or reopen review.

## Report Handling

The session that sent the request handles every review report. A report received after user-approved continuation resumes the same lane with its updated maximum.

- NEEDS_INPUT: correct the reported input and resend with enough context; do not change a valid dispatched artifact/commit
- NEEDS_REVISION: preserve Max Review Rounds, revise, and request the next round
  - draft: copy the reviewed artifact to the next numbered path, revise that copy, and leave the reviewed one unchanged
  - existing: update and commit the docs on the same design branch
- SOUND: accept
- SOUND_WITH_CAVEATS: accept only if every accepted caveat is non-blocking and already recorded in the reviewed artifact/commit; otherwise revise and re-review
- disagreement: send concise rationale to the same reviewer for the same round; do not create a new target or increment the round

If the same dispute repeats or requires a subjective/strategic choice:

- architect-author sends design_spec_decision_requested to the requester
- a review-existing requester asks the user directly

After acceptance:

- draft: author sends design_spec_delivered; requester archives and commits it
- existing:
  1. read the accepted commit from the report's Reviewed Scope
  2. require git rev-parse <design_spec_branch> to equal that commit; if it differs, stop and review the new tip
  3. rerun the review-existing path gate against the accepted commit
  4. verify the final specifications are committed, switch to the recorded base branch, require it as current, then merge the specification branch with normal git merge
  5. follow Session Cleanup for the recorded reviewer
  6. follow User Completion with design_specs_in_scope and the resulting base HEAD

For review-existing, do not squash, rebase, cherry-pick, or guess through dirty state, conflicts, detached HEAD, or base uncertainty.

## Decision Request

Use only from architect-author to requester:

~~~markdown
Task: <task_id>
Action: design_spec_decision_requested
From: architect_author <author_session_id>
To: <requester_role> <requester_session_id>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Decision Needed
[One precise user-owned decision]

## Options
- [option]: [material consequence]

## Recommendation
[author recommendation and reviewer position]

## Current Artifact
- <exact .agent-artifacts/design-spec/<author_session_id>/rNNN.md path>
~~~

### Decision Response

After the user answers, write one canonical Requester Decision Delta under `.agent-artifacts/message/` with the decision verbatim and only its resulting constraint changes. Send it unchanged to the reviewer first:

~~~markdown
Task: <task_id>
Action: design_spec_review_context
Context: decision
From: <requester_role> <requester_session_id>
To: architect_reviewer <reviewer_session_id>
Author: architect_author <author_session_id>
Session Host: <session_host>
Round: <effective round>
Max Review Rounds: <max_review_rounds>

# Requester Decision Delta
[canonical delta]
~~~

Only after that delivery returns an id, send the same delta unchanged to the author in a `design_spec_draft_requested` message with the resolved round, artifact path, unchanged archive branch, and unchanged maximum. Record both delivery ids. If reviewer delivery fails, do not send the author; if author delivery fails or either receipt is unknown, surface the partial result and do not retry automatically.

## Final Notification

Do not repeat the design specification, decisions, caveats, or implementation advice.

~~~markdown
Task: <task_id>
Action: design_spec_delivered
From: architect_author <author_session_id>
To: <requester_role> <requester_session_id>
Reviewer: architect_reviewer <reviewer_session_id>
Session Host: <session_host>
Round: final

## Delivered
- Artifact: <accepted .agent-artifacts/design-spec/<author_session_id>/rNNN.md path>
- Archive branch: <archive_branch>
- Review: <SOUND | SOUND_WITH_CAVEATS>
- Report: <review message id>
~~~

Send with subject design-spec delivered: <task_id>.

## Requester Handling

On `design_spec_review_context_recovery_requested`, recover the canonical initial context and every requester Decision Delta effective through the pending round. Replay their canonical payloads directly to the named reviewer in order; add `Recovery Complete: yes` only to the last envelope. If requester-owned authority cannot be recovered, ask the user for it. Do not source it from the author or resend the author unless shared lane fields change.

On design_spec_review_context_rejected, correct the named context and send it to the reviewer again. After reviewer delivery succeeds, send every corrected shared lane field to the author: use `design_spec_context_corrected` for metadata-only changes, or `design_spec_draft_requested` when task authority or design content changes. Do not rerun the initial wrapper or edit a reviewed artifact; only the latter case follows Round Resolution.

On design_spec_decision_requested, follow Decision Response; do not edit the artifact.

On design_spec_delivered:

1. verify the artifact exists and the report pointer records acceptance of that named path
2. if a committed formal doc on the archive branch already represents the accepted design, reuse it and continue with session cleanup and completion
3. require the current branch to equal the delivered archive branch; stop on mismatch or detached HEAD and do not switch automatically
4. require a clean index and no merge, rebase, or conflict state; do not clean unrelated worktree changes
5. choose the formal tracked docs path; stop if it has unrelated uncommitted changes
6. if substantive changes are needed, return them to the author for a new reviewed round while preserving Max Review Rounds
7. copy the accepted artifact to the formal tracked docs path, resolve trivial non-substantive issues locally, and commit that file only
8. after the archive commit succeeds, follow Session Cleanup for the delivered author and reviewer
9. treat the tracked committed doc as authoritative and cite it in later implementation work
10. follow User Completion with the tracked doc and archive commit

## Rule

Treat every Waypost send as fire-and-forget; never auto-resend outside explicit troubleshooting.
