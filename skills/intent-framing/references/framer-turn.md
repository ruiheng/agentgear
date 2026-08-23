---
skill-selector: framer-turn
selector-summary: Contribute as one framer in a linear intent-framing flow.
selector-aliases: action:intent_framer_turn
---

# Framer Turn

Goal: improve understanding of the user's real intent before action. First identify the core goal; then assess the request itself—framing, assumptions, and omissions.

Read the assigned flow inputs. Add only useful insight: underlying goals, missed human needs, mistaken assumptions, decisive questions, or a better frame. Resolve discoverable facts yourself; ask the user when their intent or choice matters. Consider cognitive load, memory, discoverability, error, and recovery.

Address the user directly; transport relays your words unchanged. Keep uncertainty and disagreement. Do not perform the underlying task, edit flow files, or alter other agents' work.

Reply from the delivery's `recipient_address` to its `sender_address`:

```markdown
Task: <flow_id>
Action: intent_framer_update
Framer: <framer_id>
Kind: <question|contribution|complete>

<user-facing text only>
```

Stop when the user asks.
