---
skill-selector: check-request
selector-summary: Complete browser-test instructions, part 1.
selector-aliases: browser-test/start, action:browser_check_requested
---

# Browser Test

Handle `browser_check_requested` and its setup round trip; report the result to requester.

Workflow protocol baseline: retrieve `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol`.

## Input

Provide `browser_check_requested`, `browser_setup_requested`, or `browser_setup_provided`.

## Primary Tool

Use `agent-browser`: `open` -> `snapshot -i` -> `@e...` interactions -> `console`/`errors` -> screenshot. Use command help only when needed.

## First-Use Environment Check

Before the first browser action in a workflow turn, confirm `agent-browser` with `command -v agent-browser`.

## Output Format

Use this exact structure as the message body:

```markdown
Task: <task_id>
Action: browser_check_report
Planner: <planner_session_id_or_N/A>
Round: <round>
Browser Check: <browser_check_id>

## Decision
PASS / FAIL / UNKNOWN

## Coverage
[What batch of scenarios or checks were actually exercised]

## Findings
- [finding or `None`]

## Code Change Summary
- Code changed: [yes/no]
- Branch: [branch name or `N/A`]
- Commit: [short prefix or `N/A`]
- Files changed: [list or `None`]

## Evidence
- Steps executed: [summary]
- Console errors: [summary or `None`]
- Page errors: [summary or `None`]
- Network observations: [summary or `None`]
- Screenshots: [paths or `None`]

## Reproduction
1. [short repro path]

## Residual Risk
[What remains unverified]
```

## Multi-Agent Mode

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol multi-agent-protocol/session-host` for shared protocol.

Resolve by `Action:` before generic fields:
- all actions: `browser_check_id`: required `Browser Check` header; if absent, fail and request a fresh message; never infer it from Task/Round
- `browser_check_requested`:
  - `task_id`, `round`: explicit -> headers -> ask/default
  - `planner_session_id` (optional): explicit -> message body -> omit when absent or `N/A`
  - browser tester identity: current bound session; requester reply route: received `sender_address`
  - `browser_tester_workspace`, `requester_workspace`: message body -> current workspace -> ask
  - `requester_role`: explicit request context -> `requester`
  - setup contact id/workspace/role: message body `Setup Contact` -> requester values
- `browser_setup_requested`:
  - `task_id`, `round`: headers
  - tester reply route: received `sender_address`; contact route: current delivery recipient
  - omit requester, planner, and original Setup Contact resolution
- `browser_setup_provided`:
  - `task_id`, `round`: headers; match Browser Check to the active setup frame and require its setup-contact -> tester endpoints
  - recover requester, planner, and browser frame only from the matching check history

## Setup Round Trip

For a `browser_check_requested` blocked by login, auth, environment, or test data:

```markdown
Task: <task_id>
Action: browser_setup_requested
Round: <round>
Browser Check: <browser_check_id>

## Missing Prerequisites
- <login, auth, environment, or test-data need>
```

- send that exact request to Setup Contact; require target at its declared workspace, then `waypost_defer` the claimed check once with `until` set to a bounded setup deadline; never release or re-defer it
- on `browser_setup_requested`, reply to its received `sender_address` with `browser_setup_provided`, Task/Round/Browser Check, and setup or `Unavailable: <reason>`, then ACK; never send secrets through Waypost
- on `browser_setup_provided`, follow `agentgear skill get browser-test/setup-provided`; ACK only after its sender gate passes, and do not resume a check in that turn. Recover the ACKed reply later with `waypost_read` by `Browser Check`
- on the deferred check, read its ACKed matching reply: reply -> continue (`Unavailable` -> `UNKNOWN`); no reply at deadline -> send `UNKNOWN` (`setup unanswered`) and ACK the check. Never resume from an unclaimed reply or match by Task/Round alone

Execution flow (`browser_check_requested`):
1. run the first-use environment check
   - if `agent-browser` is unavailable, stop and report the blocker instead of improvising with another browser tool
2. execute the requested browser steps with `agent-browser`
   - if the request explicitly allows browser-tester edits, it may modify display-adjacent code on the requested branch before rerunning browser validation
   - for missing login, auth, environment, or test data, use Setup Round Trip once; if setup is unavailable, report `UNKNOWN`
3. collect runtime evidence
4. produce one `browser_check_report`
5. use `waypost`
6. send it back to the requester with `waypost_send`
   - `from_address = <current bound browser-tester Waypost address>`
   - `to_address = <received check sender_address>`
   - `subject = "browser report: <task_id> r<round>"`
   - `body = <browser-check report body>`

## Rules

- cover the full requested batch by the shortest useful path; report covered, failed, and unverified points
- if environment, auth, data, setup, or identity blocks reliable validation, report `UNKNOWN` or the explicit blocker
- by default, do not change code from this role
- if the request explicitly allows browser-tester edits, limit them to display-adjacent code and keep them on the requested branch
- keep findings factual and tied to observed browser evidence
- prefer setup-contact-provided login/auth/setup context over re-discovering it from scratch
- treat `Browser Check` as the check correlation key; Task/Round describe scope only
- return the report to requester, not Setup Contact
- preserve the requester workspace for setup routing and workflow recovery; report delivery itself uses the received check `sender_address`
- Do not naturally end after writing the report; this workflow turn is complete only after the required `waypost_send` back to the requester has succeeded
