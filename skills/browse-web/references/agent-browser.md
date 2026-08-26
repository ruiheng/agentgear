---
runtime-command: agent-browser
append-to-selector: start
---

## Runtime guidance: agent-browser

`agent-browser` is available on `PATH` and is a useful candidate for rendered, interactive, or JavaScript-dependent pages. Prefer a suitable built-in browser capability when it is better integrated with the current task; otherwise use the normal `open` → `snapshot -i` → element interaction flow and collect only the evidence the request needs.
