---
skill-selector: framer-update
selector-summary: Relay and record an intent framer's direct user update.
selector-aliases: action:intent_framer_update
---

# Framer Update

Accept only matching Task, Framer, and delivery routes: sender=current framer address; recipient=recorded return address. ID and host are continuity data, not delivery identity. Record Kind; append user-facing text verbatim.

- `question`: show text to the user; append the reply; send it with action `intent_framer_turn`.
- `contribution`: show when useful; keep the current framer active.
- `complete`: present the frame to the user; report the artifact; continue only if the user wants the next framer.

If the flow is stopped, do not append late updates or launch more work.
