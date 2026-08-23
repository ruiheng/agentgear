---
skill-selector: roundtable
selector-summary: Run intent framing through the existing iterative roundtable.
---

# Roundtable Mode

Initialize a roundtable flow directory, then retrieve and run `agentgear skill get roundtable`. Keep its moderator, group-stream, participant, and stopping semantics unchanged. Let the user choose each participant's model or explicit tool command; preserve exact choices.

Record the roundtable id, group address, and each moderator synthesis under the flow directory. The roundtable workflow remains authoritative for participants and raw discussion.

The user may stop after any exchange or synthesis. Record `stopped` and deliver the current flow directory without requiring consensus.
