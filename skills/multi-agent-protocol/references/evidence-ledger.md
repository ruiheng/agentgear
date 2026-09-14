---
skill-selector: evidence-ledger
selector-summary: Persist verified repository facts in per-role ledgers shared under one task directory.
---

# Evidence Ledgers

Keep verified repository facts in `.agent-artifacts/evidence/<task_id>/`, one
file per role (`author.md`, `reviewer.md`, `pruner.md`, ...). Write only your
own file; read all of them. Create your file on first write.

One fact per line, newest last:

```markdown
- <verified claim> — <path>:<start>-<end> "<short anchor quote>", rNNN
```

The anchor quote relocates a shifted range without a full reread. When the
repository or user authority stops supporting an entry, mark it
`invalidated rNNN: <reason>` rather than deleting it.

Retained conversation summarizes; the ledger survives context compaction.
Reuse your own entries as verified across rounds; spot-check an anchor only
when the current diff or a contested finding touches that source, then refresh
its round. In design lanes the diff is the artifact diff; in implementation
lanes it is the new commits under review. Treat another role's entries as
leads, not conclusions: verify the named anchor directly, then record the fact
in your own ledger.
