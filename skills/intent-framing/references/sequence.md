---
skill-selector: sequence
selector-summary: Run a linear sequence of independent intent framers.
---

# Sequence

Initialize the flow. Per framer: explicit model, profile, or command wins; otherwise resolve `intent_framer`. Resolve independently; record exact model, launcher, focus. Resolver fallback is launch recovery only, never another framer. Never silently replace explicit choices or diversify. Unmappable exact model: ask.

One fresh persistent session per framer; run serially. Read input and additions; unless explicitly independent, also read prior framer files in order. Prior frames remain contestable contributions, not accumulated truth. Focus directs attention; it must not supply premises, a domain model, a solution direction, or the conclusion. Unless the user selects a lens, use `none`; do not invent one from coordinator synthesis. One artifact per framer; requester alone appends relayed exchanges.

Each artifact: an intent frame or material refinement. Preserve independent views; synthesize only through a user-selected framer.

Create or require the framer from its recorded launcher. Before dispatch, activate it with the returned host, real id, sole address, and the requester address used to send. Send from that requester address with this envelope:

```markdown
Task: <flow_id>
Action: intent_framer_turn
Framer: <framer_id>

Flow: <manifest path>
Artifact: <framer artifact path>
Inputs:
- <readable path; repeat as needed>
Focus: <focus or none>
User turn: <new user reply, if any>
```

Transport metadata alone supplies reply routing. Relay exchanges without synthesis.

On a framer update, follow `intent-framing/framer-update`. Start the next framer only after the current one completes or the user asks to move on.

On user stop: record `stopped`; launch nothing; deliver the directory as-is. Resume only explicitly; no implicit synthesis.
