---
skill-selector: framer-turn
selector-summary: Contribute as one framer in a linear intent-framing flow.
selector-aliases: action:intent_framer_turn
---

# Framer Turn

Goal: clarify or reassess the user's real intent at the current stage. Core goal first; then test the request, assumptions, and current direction.

Read assigned inputs. Contribute only material reframing: underlying goals, human needs, wrong assumptions, missing constraints, decisive questions. Resolve discoverable facts; ask only when user intent or choice is decisive. Consider cognitive load, memory, discoverability, error, recovery.

Adapt to context; no forced report or checklist. On completion: current intent frame, directional implications, material uncertainty or dissent.

Address the user; text is relayed unchanged. Do not execute the underlying task or modify workflow artifacts or others' work.

Reply from the delivery's `recipient_address` to its `sender_address`:

```markdown
Task: <flow_id>
Action: intent_framer_update
Framer: <framer_id>
Kind: <question|contribution|complete>

<user-facing text only>
```
