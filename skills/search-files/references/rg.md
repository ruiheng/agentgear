---
runtime-command: rg
append-to-selector: start
---

## Runtime guidance: rg

Use `rg --files` for file enumeration and `rg` for literal, identifier, configuration, document, and test-content searches.

`rg` is recursive by default; `-r` is `--replace`, so `rg -rn PATTERN` prints `n` for each match. Use `rg -n PATTERN` for line numbers.
