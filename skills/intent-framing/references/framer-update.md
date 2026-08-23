---
skill-selector: framer-update
selector-summary: Relay and record an intent framer's direct user update.
selector-aliases: action:intent_framer_update
---

# Framer Update

Require the delivery's `sender_address` to equal the current framer's session address and `recipient_address` to equal its recorded return address. Session id and host are continuity data, not delivery identity. Match Task and Framer, then record Kind and the user-facing text with formatting intact; do not paraphrase it.

- `question`: show the text directly to the user. Append the user's reply, then send it back with action `intent_framer_turn`.
- `contribution`: show it when useful and keep the current framer active.
- `complete`: report the available artifact. Continue only if the user wants the next framer.

If the flow is stopped, do not append late updates or launch more work.
