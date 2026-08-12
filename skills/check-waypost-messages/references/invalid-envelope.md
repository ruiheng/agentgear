---
skill-selector: invalid-envelope
selector-summary: Handle a malformed claimed Waypost envelope safely.
---

# Invalid Envelope

Report the malformed envelope. Call `waypost_fail` for the claim when available; otherwise release it. Do not acknowledge it or infer an Action.
