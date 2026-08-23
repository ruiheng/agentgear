---
skill-selector: sequence
selector-summary: Run a linear sequence of independent intent framers.
---

# Sequence

Initialize the flow with its input. Record each framer's exact model, matching launcher, and optional focus. Never substitute silently; ask when an exact model cannot be mapped to one launcher. Use resolver role `intent_framer` only when the user leaves the model unspecified.

Run one persistent framer session at a time. New framers read `input.md`, additions, and prior framer files in order. An explicitly independent framer may omit prior framer files. Each framer has a fresh model context and one assigned artifact; the requester alone appends relayed exchanges to that file.

Create or require the framer from its recorded launcher. Before dispatch, activate it with the returned host, real id, sole address, and the requester address used to send. Send from that requester address with this envelope:

```markdown
Task: <flow_id>
Action: intent_framer_turn
Framer: <framer_id>

Flow: <manifest path>
Artifact: <framer artifact path>
Inputs:
- <readable input path>
Focus: <focus or none>
User turn: <new user reply, if any>
```

Transport metadata alone supplies reply routing. Relay exchanges without synthesis.

On a framer update, follow `intent-framing/framer-update`. Start the next framer only after the current one completes or the user asks to move on.

At any user stop: record `stopped`, launch nothing else, and deliver the flow directory as-is. It may be resumed later. No synthesis or shared conclusion is required unless the user selected a framer to produce one.
