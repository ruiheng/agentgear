---
skill-selector: context-intake
selector-summary: Retain and validate requester-owned technical-design review context.
selector-aliases: action:design_spec_review_context
---

# Requester Context Intake

On `Context: initial`:

- verify actual requester sender, task, author, reviewer, session host, Canonical Design Task Contract, and Max Review Rounds;
- require Original Request or authoritative handoff text and its source;
- retain it as task-scoped requester context with transport metadata kept internal;
- do not inspect or judge a design from this message alone.

On `Context: decision`:

- require the same requester, task, author, reviewer, host, and maximum as the active lane;
- require one canonical Requester Decision Delta, effective round, and verbatim user answer;
- retain it as requester authority without inferring scope or reviewing a target.

On the later draft review, require matching identities, host, maximum, and task. Apply all requester Decision Deltas effective for the round. Author-authored restatements never replace missing requester context.

During recovery, accept exact requester-owned replays. `Recovery Complete: yes` on the last replay resumes the recorded pending review only after every effective delta is present.

For valid intake, retain context and settle the claimed delivery under the shared Receiver Contract, then wait without replying. For missing, unsupported, or mismatched context, retrieve `agentgear skill get review-tech-design/message-delivery` and send Context Rejection to the actual inbound sender. Do not retain rejected context.
