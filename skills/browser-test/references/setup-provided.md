---
skill-selector: setup-provided
selector-summary: Process browser setup details supplied by a collaborator.
selector-aliases: action:browser_setup_provided
---

# Browser Setup Provided

## Setup Reply Receive

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`.

On `browser_setup_provided`, resolve the received route before settlement:

- require `Browser Check`; if it is absent, fail the claimed reply and request a fresh setup reply. Never infer it from Task or Round.
- match Task, Round, and Browser Check to the active setup request or retained check frame;
- require the actual `sender_address` to equal that frame's setup-contact target and the current recipient to equal its tester route. Missing context defers; a mismatch is rejected without using setup details;
- after the gate passes, use the recorded target as the setup-contact route and the current delivery recipient as tester;
- recover requester, planner, tester workspace, and the browser-validation frame only from the matching check history keyed by `Browser Check`. Never default a different check from Task or Round.
- require the complete `## Setup` section; it contains setup details or one
  `Unavailable: <reason>` result.

After the matching frame is recovered, acknowledge the claimed reply; do not resume a check in this turn. Recover the ACKed reply later by `Browser Check` only. Use the received setup details only for the active browser-validation flow, never to infer a different requester, planner, or check.
