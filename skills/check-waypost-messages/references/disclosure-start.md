---
skill-selector: start
selector-summary: Complete check-waypost-messages instructions, part 1.
---

## Receiver algorithm

1. Follow the active Waypost tool contract. Call `waypost_status` first only
   when that contract requires it, then call `waypost_recv` to claim one
   personal delivery. If no delivery is returned, report that and stop.
2. Parse the received `body` without sending any of it to a shell:
   - normalize CRLF to LF for parsing only;
   - take the consecutive non-empty lines from byte zero through the first
     empty line as the header block;
   - examine header names case-insensitively for duplicates, but accept only
     one line spelled exactly `Action: <token>`;
   - reject a missing Action line, repeated Action line, case-variant name,
     malformed value, whitespace-bearing value, or any token that does not
     match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. Do not trim a value into
     validity.
3. For an invalid envelope, retrieve
   `agentgear skill get check-waypost-messages invalid-envelope` and follow
   it. For a valid token, construct only the constant-prefixed lookup value
   `action:` plus the validated token and invoke exactly one structured-argv
   lookup for that completed selector.
   Never pass the raw body or raw header line to the launcher. If a shell is
   the sole available interface, use a fixed command template and the
   grammar-validated token as one quoted argv argument after `--`; never use
   eval, substitution, pipes, redirection, or concatenation of unvalidated
   text.
4. A status-2 result means the token is unregistered. Retrieve
   `agentgear skill get check-waypost-messages unknown-action` and follow it.
   Otherwise follow the returned owning selector body; it is the first
   executable workflow stage. Only the six discriminator aliases
   (`browser_check_report`, `design_spec_review_context_recovery_requested`,
   `design_spec_review_requested`, `group_message_available`,
   `rework_required`, and `stop_recommended`) make a further decision from
   the already received message.
5. The returned selector owns claim settlement. Before ending, settle every
   claim owned by this session: acknowledge only after its immediate required
   action completes; release/defer only when it cannot proceed; fail a routing
   error when supported. Never settle an outbound or another session's claim.
