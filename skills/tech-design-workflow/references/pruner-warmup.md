---
skill-selector: pruner-warmup
selector-summary: Warm up a newly created design pruner with its key skills.
---

# Pruner Warmup

Before the first dispatch that names a newly created `design_pruner`, send it
one warmup:

```bash
agentgear run multi-agent-protocol send-skill-warmup.mjs \
  --task-id "<task_id>" \
  --from-address "<manifest author_to_address>" \
  --to-address "<pruner address>" \
  --skill multi-agent-protocol/shared-protocol \
  --skill action:design_prune_requested \
  --json
```

Run with host permission. A nonzero exit leaves the pruner cold: report it and
stop before dispatch. A recovered existing pruner needs no new warmup.
