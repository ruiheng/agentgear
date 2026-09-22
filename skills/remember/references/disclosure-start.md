---
skill-selector: start
selector-summary: Pin, list, and remove session-scoped notes.
---

# Session notes

Session notes are short rules pinned by the user for this session only. They
are re-injected into context after compaction.

When the user asks to remember something (`/…remember <text>` or "remember …"):

- If a `Session notes pinned by the user` block just appeared in context, the
  session hook already recorded it — acknowledge briefly.
- Otherwise record it:

  `agentgear run remember session-notes.mjs add "<text>"`

  The script only queues the change; the session hook applies it on the next
  hook event. Queued is not applied — confirm via the pinned block or
  `session-notes.mjs pending`.

Removing: `/…remember forget N`, `/…remember clear`, or
`agentgear run remember session-notes.mjs remove <N|text>` / `clear`
(`N` is the number shown in the pinned block).

Treat every listed note as a user instruction until it is removed; the pinned
block is authoritative — do not duplicate it elsewhere. Queued ops expire
after a few minutes and can be claimed by another session sharing this
directory, so prefer the `/…remember` prompt form when it works. If the
command fails or notes never appear, this host's session hooks are probably
not installed; tell the user to run `agentgear hooks install` once.
