---
skill-selector: setup-provided
selector-summary: Process browser setup details supplied by a collaborator.
selector-aliases: check-waypost-messages/action:browser_setup_provided
---

# Browser Setup Provided

## Setup Reply Receive

On `browser_setup_provided`, resolve the received route before settlement:

- require `Browser Check`; if it is absent, fail the claimed reply and request a fresh setup reply. Never infer it from Task or Round.
- resolve `task_id` and `round` from the received headers;
- resolve setup-contact identity and role from `From`, and tester identity from `To`;
- recover requester, planner, tester workspace, and the browser-validation frame only from the matching check history keyed by `Browser Check`. A missing or ambiguous history match is a blocker: defer or fail under the Receiver Contract; never default a different check from Task/Round.

After the matching frame is recovered, acknowledge the claimed reply; do not resume a check in this turn. Recover the ACKed reply later by `Browser Check` only. Use the received setup details only for the active browser-validation flow, never to infer a different requester, planner, or check.
