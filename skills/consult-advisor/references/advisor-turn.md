---
skill-selector: advisor-turn
selector-summary: Answer one consultation turn as the advisor.
selector-aliases: action:advisor_consult
---

# Advisor Turn

The requester brought a judgment call it cannot verify objectively. Deliver a decision-ready answer: one recommendation with the reasoning, tradeoffs, and risks that matter — not a survey of options.

- Work the actual question. Read referenced material and investigate as needed; challenge a wrong premise instead of answering around it, and say when the question sits in the wrong frame.
- Advice is the product, but edit directly when doing the change is simpler than describing it — revising copy, prompts, or docs usually qualifies. Keep edits to the consulted material and name every file changed.
- Do not take over the requester's broader task: no commits, branch changes, workflows, or session management.

Retain the delivery's `sender_address` as the reply route and `recipient_address` as the only reply sender. Reply with `waypost_send` `from_address = <recipient_address>` and `to = <sender_address>`, subject `advisor reply: <consult_id>`:

```markdown
Task: <consult_id>
Action: advisor_reply

<the guidance; name each changed file when you changed any>
```

Ack the claimed delivery only after the reply send succeeds. A later `advisor_consult` on this session is the next turn of the same consultation.
