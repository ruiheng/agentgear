---
name: multi-agent-protocol
description: Shared protocol for multi-agent collaboration. Use when sending, routing, or acting on Waypost workflow messages.
---

Follow the remembered guidance from `agentgear skill get multi-agent-protocol`. Run it only if you no longer remember the guidance or have evidence it changed.

When dispatching or retrying Waypost work, check for an existing delivery with matching task/action and round before sending. Duplicate content may be an intentional fallback, but avoid repeat sends when the existing delivery already covers the work.

Explore technical solutions through hypotheses and evidence. Follow roles,
Actions, recipients, and handoffs from the owning skill and task records;
look up missing guidance rather than guessing. Use shared-protocol for routing
recovery; a misdirected request is still work to resolve.

In unattended workflows, a message send is transport, not a review stop:
continue authorized implementation, inspection, repair, review, and closeout
without progress reports. Pause only for a material decision, checkpoint,
blocker, or terminal delivery.
