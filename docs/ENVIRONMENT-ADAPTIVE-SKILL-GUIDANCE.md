# Environment-Adaptive Skill Guidance

## Decision

Agentgear supports a narrow runtime-guidance layer for canonical skill selectors. It appends authored guidance only for relevant external commands that are ready in the current environment.

Runtime guidance is always advisory. It identifies known candidates; it does not override a better harness-native or built-in capability, grant permission, establish trust, install anything, or require the agent to use a detected command.

The first three behavior skills are:

- `browse-web`: append `agent-browser` guidance when that command is available. If it is absent, append no CLI recommendation. In particular, do not add a `curl` fallback; the agent remains free to use an appropriate built-in or independently available capability.
- `browser-test`: append the `agent-browser` sandbox constraint when that command is available. Its complete base selector still reports an unavailable command as a blocker.
- `search-files`: help locate information across a large local file collection. Append available `fd`, `rg`, `mq`, `yq`, and `ast-grep` guidance independently; they cover paths, text, structured documents, YAML, and source syntax respectively. Append `codegraph` guidance only when its CLI is available and the current workspace already has a CodeGraph index; that advice applies only to source-code corpora. Never create an index as part of guidance detection.

`browse-web` and `search-files` are normal implicit entries in the `core` pack; `browser-test` remains prompt-only in the `browser` pack. Existing selectors without runtime appendices retain byte-identical output.

## Ownership boundaries

- `skills/<name>/` owns all agent-facing base text and runtime appendix text.
- `catalog/skills.json` owns the finite runtime-command registry and supported readiness predicates.
- `providers/external-commands.mjs` owns environment observation.
- `cli/lib/skill-content.mjs` owns appendix validation, indexing, and composition.
- `cli/agentgear.mjs` resolves requested selectors atomically, observes only their relevant commands once, and composes the result.

No generated prompt code, environment cache, persistent selector index, network probe, tool installation, or arbitrary predicate execution is involved.

## Catalog model

The optional `runtimeCommands` object declares every candidate by name:

```json
"runtimeCommands": {
  "agent-browser": {},
  "ast-grep": {},
  "codegraph": {"readiness": "codegraph-index"},
  "fd": {},
  "mq": {},
  "rg": {},
  "yq": {}
}
```

Each value is an object with no fields or one supported `readiness` value. Version one supports only `codegraph-index`, and only for `codegraph`. Object order has no decision semantics; every ready command with an authored appendix is included independently.

Command names match `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`. Runtime guidance declarations are not pack prerequisites and do not affect install, update, doctor, or permission generation.

## Runtime appendix files

A Markdown file below the owning skill's `references/` directory can declare:

```markdown
---
runtime-command: codegraph
append-to-selector: start
---

## Runtime guidance: codegraph

Advisory guidance owned by this skill.
```

The frontmatter accepts only those two fields. The command must be declared in the catalog, the target must be a canonical selector owned by the same skill, and each owner/selector/command tuple is unique. Selector, agent-appendix, and runtime-appendix metadata cannot be mixed.

The body must begin with the exact protective heading shown by its metadata. Runtime appendices share the existing 8 KiB limit, contained symlink-free traversal, normalized-newline, reference, Markdown-fence, and staged-runtime validation. They cannot declare `Action:`, `From:`, or `To:` headers. A selector must remain complete and safe when every runtime appendix is omitted.

## Environment observation

External command detection performs filesystem metadata and access checks only. It never runs a candidate or a shell.

- Command lookup inspects `PATH` in order and accepts regular files that pass executable access checks.
- Windows lookup honors valid `PATHEXT` entries, with `.COM`, `.EXE`, `.BAT`, and `.CMD` as the fallback list.
- Missing files, permissions, races, invalid input, and probe errors mean “candidate unavailable”; they do not make skill retrieval fail.
- Detection returns only command readiness to the composer. Absolute executable paths are not injected into agent-facing text.

CodeGraph has an additional workspace gate. Starting at the current working directory and walking to the filesystem root, Agentgear looks for a CodeGraph data directory containing a regular `codegraph.db`. The directory is `.codegraph` by default. Like CodeGraph, detection trims `CODEGRAPH_DIR` and accepts a single directory name; empty values, `.`, values containing `..` or a path separator, and absolute paths fall back to `.codegraph`. Detection does not invoke `codegraph`, inspect its version, download a bundle, or generate/refresh an index.

## Composition and CLI behavior

For `agentgear skill get ADDRESS...`, Agentgear:

1. resolves every requested address before probing or writing stdout;
2. collects only command declarations referenced by those resolved selectors;
3. observes readiness once for the invocation;
4. composes base selector → detected agent appendix → ready runtime appendices;
5. preserves the existing single- and multi-address text framing.

An unknown or ambiguous address still fails atomically with no stdout. Authored catalog or appendix corruption remains a status-1 error. Optional command absence never changes exit status.

## Refresh semantics

Stable skills retain the normal remember-and-reuse policy. `browse-web` and `search-files` are explicit environment-adaptive exceptions: their concise bootstraps tell the agent to retrieve the entry at the start of each matching task turn. This refreshes candidate advice without requiring a probe before every command.

Even after retrieval, the agent makes the final capability choice. A built-in tool may be better than an appended candidate, and a candidate that disappears can be replaced using the complete base selector behavior.

## Validation

Source and staged-runtime validation cover the catalog schema and appendix isolation. Tests cover independent omission, Windows `PATHEXT`, the CodeGraph index gate, and unchanged unrelated selectors. Run `npm run check` before release; regenerate `dist/` through the build only.
