---
skill-selector: advisor-reply
selector-summary: Receive an advisor's guidance for a recorded consultation.
selector-aliases: action:advisor_reply
---

# Advisor Reply

Accept only when Task matches a recorded consultation and the sender is its recorded advisor address; otherwise handle the delivery as unsolicited.

Treat the reply as strong guidance from a stronger model: adopt it unless concrete evidence it lacked contradicts it, and raise that conflict in a follow-up turn instead of silently overriding. Review any files it changed before building on them; commits and delivery stay with the requester.

Then apply the Ending rule from `consult-advisor/start`.
