---
skill-selector: start
selector-summary: Complete check-waypost-messages instructions, part 1.
---

## Receiver algorithm

Call `waypost_status` once to initialize MCP tool discovery. If unavailable,
use the Waypost CLI.

1. Claim one personal delivery with `waypost_recv`, or `waypost recv` when
   using the CLI. If none is returned, report that and stop.
2. Parse the received `body` without sending any of it to a shell:
   - normalize CRLF to LF for parsing only;
   - take the consecutive non-empty lines from byte zero through the first
     empty line as the header block;
   - treat a line matching `^\s*Action\s*:` case-insensitively as Action-like;
     if the block has none, handle the body as an ordinary
     personal message and settle it under the Receiver Contract; do not infer
     an Agentgear workflow action;
   - otherwise require exactly one line spelled `Action: <token>`; repeated,
     case-variant, or malformed Action fields are invalid, and the token must
     match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}` without trimming.
3. For an invalid Action field, retrieve
   `agentgear skill get check-waypost-messages/invalid-envelope` and follow
   it. For a valid token, invoke the structured argv
   `["agentgear","skill","get","--","action:" + token]` exactly once.
   Never pass the raw body or raw header line to the launcher. If a shell is
   the sole available interface, use a fixed command template and the
   grammar-validated token as one quoted argv argument after `--`; never use
   eval, substitution, pipes, redirection, or concatenation of unvalidated
   text.
4. A status-2 result means the token is unregistered. Retrieve
   `agentgear skill get check-waypost-messages/unknown-action` and follow it.
   Otherwise follow the returned owning selector body; it is the first
   executable workflow stage. Do not assume it remembers the shared protocol;
   every return or outcome selector must apply its own Expected Sender Gate
   before acting on result content. Only the five discriminator aliases
   (`browser_check_report`, `design_spec_review_requested`, `group_message_available`,
   `rework_required`, and `stop_recommended`) make a further decision from
   the already received message.
5. The returned selector owns claim settlement. Before ending, settle every
   claim owned by this session: acknowledge only after its immediate required
   action completes; release/defer only when it cannot proceed; fail a routing
   error through the Waypost CLI. Never settle an outbound or another
   session's claim.
