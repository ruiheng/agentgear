---
skill-selector: roundtable
selector-summary: Run intent framing through the existing iterative roundtable.
---

# Roundtable Mode

Initialize the flow directory. Retrieve the roundtable skill with `agentgear skill get roundtable`; run it unchanged. Preserve explicit participant model or tool choices; otherwise keep roundtable defaults.

Record roundtable id, group address, and moderator syntheses in the flow directory. The roundtable workflow remains authoritative for participants and raw discussion.

Moderator synthesis: current intent frame, directional implications, uncertainty, dissent. No forced consensus or checklist.

On user stop: record `stopped`; deliver the current directory; no consensus required.
