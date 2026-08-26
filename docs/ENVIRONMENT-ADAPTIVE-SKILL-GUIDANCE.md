# Environment-Adaptive Skill Guidance

## Decision

Implement a narrow, declarative runtime-guidance layer for canonical skill selectors and expose its first two uses through focused, generally reachable behavior skills:

- `browse-web` handles an ordinary request to read or navigate a web page. Its ranked `web-page` group prefers `agent-browser` and falls back to `curl` guidance only when `agent-browser` is unavailable and `curl` is available.
- `explore-code` handles ordinary read-only exploration of an unfamiliar codebase. Its additive `code-exploration` group includes every available `rg`, `ast-grep`, and `codegraph` fragment because text, structural, and graph exploration complement one another.

The capability is worth adding because selector content is already indexed and composed per `agentgear skill get` invocation, and the existing agent-profile appendices prove that optional selector-owned additions can remain outside the workflow engine. Keep ordinary selector bodies stable; only selectors that explicitly own runtime appendices become environment-sensitive.

Do not attach either generic behavior to `explore-defects`. That skill is deliberately explicit-only and narrowly scoped to defect-family exploration from known evidence; it remains unchanged. Do not change the dedicated `browser-test` contract either: it still requires `agent-browser`, because `curl` cannot substitute for rendered interactive browser validation.

## Goals and boundaries

The implementation must:

- keep all authored agent-facing text under `skills/<name>/`;
- make ordinary web browsing and code exploration discoverable through behavior-named implicit entries rather than through a mechanism or specialist-analysis skill;
- keep the catalog authoritative for every command that may affect composition;
- preserve byte-identical output for existing selectors and all selectors with no runtime appendices;
- make selection order deterministic and visible in the returned guidance;
- define an explicit refresh boundary so remembered availability does not become a stale tool choice;
- preserve atomic multi-address lookup and the current status-1/status-2 failure distinction;
- work from source, staged runtimes, the shared launcher, and copy-fallback wrappers without cache or generated index state.

Version one does not install tools, grant command permissions, probe versions or configuration, inspect the network, query MCP tool registries, detect repository language/framework or working-directory contents, evaluate arbitrary predicates, run skill-owned prompt generators, or persist an environment snapshot. Platform is used only for executable-name resolution (`PATHEXT` on Windows). Agent-profile appendices remain an independent composition dimension.

## Public entry and pack changes

Add canonical directories `skills/browse-web/` and `skills/explore-code/`. Each owns a concise `SKILL.md`, `agents/openai.yaml`, a `start` selector, and its runtime appendix fragments. They are normal implicit behaviors:

- do not set Claude Code `disable-model-invocation: true`;
- do not set Codex `policy.allow_implicit_invocation: false`;
- give each interface description and default prompt the concrete user behavior, not “runtime guidance” or tool-selection terminology.

Declare both catalog records with `exposure: "entry"` and standalone tags, and add both to the `core` pack. They have no workflow, Waypost, session-host, upstream, or required-command dependency. Optional runtime-guidance commands do not become pack requirements.

The current catalog and exposure test contain 15 entries, including `intent-framing`; the older fourteen-entry wording in `docs/PROGRESSIVE-SKILL-DISCLOSURE-DESIGN.md` is already stale relative to that repository evidence. This change intentionally makes the fixed public surface exactly 17 entries:

```text
assess-tech-design
browse-web
check-waypost-messages
code-health-review
commit-staged
delegate-code-task
delegate-task
explain-for-me
explore-code
explore-defects
fix-strategy
handoff
intent-framing
refactor-review
roundtable
simplify-review
tech-design-workflow
```

Update the checked-in entry fixture, catalog exposure tests, documentation, generated target layouts, and build assertions to this exact bytewise-sorted list. `core` exposes its existing six entries plus the two new entries. `workflow` and `browser` pack closures do not gain the new skills; `browser` remains the interactive browser-validation workflow pack rather than a generic web-reading pack. The implicit/default `all` closure includes `core`, so normal installation exposes all 17.

Do not add the new names to `LEGACY_SKILL_NAMES`: they were never installed by a pre-change release, and the exceptional migration whitelist must not gain prospective deletion authority.

## Declarative model

### Catalog groups

Add an optional top-level `runtimeGuidance` object to `catalog/skills.json`:

```json
"runtimeGuidance": {
  "web-page": {
    "selection": "first-available",
    "commands": ["agent-browser", "curl"]
  },
  "code-exploration": {
    "selection": "all-available",
    "commands": ["rg", "ast-grep", "codegraph"]
  }
}
```

Group names use the selector-token grammar. `selection` is exactly `first-available` or `all-available`. `commands` is a non-empty, unique ordered array of bare command names. A command name must match `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`; this ASCII-only, 128-byte maximum excludes path separators, drive/URI colons, whitespace, control bytes, shell syntax, leading dots, and parent-path tokens. Array order is semantic only inside a group. A command in this object is an optional runtime-guidance declaration: it never becomes a pack prerequisite and never affects install, update, doctor, or readiness. It may also appear in `packs.*.requires.commands` for a separate mandatory use, as `agent-browser` already does.

Keep catalog schema version 1: this is an optional field consumed atomically by the same release, and old catalogs without it mean that no runtime guidance exists.

### Runtime appendix files

Extend the contained Markdown index with a third document kind alongside selectors and agent appendices:

```markdown
---
runtime-guidance: web-page
runtime-command: agent-browser
append-to-selector: start
---

## Runtime guidance: web-page via agent-browser

Agentgear observed `agent-browser` on PATH for this retrieval. ...
```

The only allowed fields are `runtime-guidance`, `runtime-command`, and `append-to-selector`:

- the group must exist in catalog `runtimeGuidance`;
- the command must be a member of that group;
- the target must be a canonical selector owned by the same skill;
- one owning skill/target/group/command tuple may have only one appendix;
- selector, agent-appendix, and runtime-appendix metadata are mutually exclusive;
- the body must start with the exact CommonMark heading `## Runtime guidance: <group> via <command>` (allow zero to three leading spaces and trailing heading whitespace, as for agent guards).

Runtime appendices are subject to the existing 8 KiB slice limit, symlink-free traversal, normalized newline rules, Markdown-fence validation, documented `agentgear skill get` and `agentgear run` reference validation, and staged-runtime integrity checks. Like agent appendices, they may not contain physical `Action:`, `From:`, or `To:` headers. They are optional advice: the target selector must remain complete and safe when no appendix is selected.

The catalog owns availability policy and ordering; the Markdown fragments own domain guidance. The CLI therefore learns no web- or code-specific behavior.

## Availability provider

Move the existing cross-platform `isCommandAvailable` implementation out of `cli/lib/upstreams.mjs` into `providers/external-commands.mjs`, and import it from both upstream/doctor code and runtime composition. Add a helper that accepts the finite command set relevant to one retrieval and returns a `Set` of available names.

For runtime guidance, availability means:

1. validate the command against the exact catalog grammar above;
2. split `PATH` with `path.win32.delimiter` for an injected/actual Windows platform and `path.posix.delimiter` otherwise;
3. ignore empty and non-absolute path entries, normalize accepted directories with the corresponding path implementation, and deduplicate them in first-observed order (case-fold the deduplication key on Windows), so the current working directory cannot implicitly affect the result;
4. when Windows command names have no extension, parse `PATHEXT` with the bounded rules below; when a command already has an extension, test only the declared name;
5. for every command/suffix pair, resolve the candidate against the normalized PATH directory and require its relative path to be one non-empty immediate-child basename with no separator and `path.dirname(relative) === "."` before any metadata or access call;
6. count a contained candidate only when following it yields a regular file and it passes the platform executable-access check;
7. treat missing files, permission errors, races, and other probe errors as unavailable.

`PATHEXT` is untrusted input and is never concatenated before validation. Use these constants and parsing rules:

- fixed default extensions, in order: `[".COM", ".EXE", ".BAT", ".CMD"]`;
- maximum raw `PATHEXT` size: 4096 ASCII bytes; maximum semicolon-delimited segments: 64; values exceeding either bound use the fixed default list;
- accepted segment grammar: `^\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$`; do not trim a segment into validity;
- discard individual empty or invalid segments, convert accepted ASCII segments to uppercase, and deduplicate them while preserving first occurrence;
- accept at most 32 normalized extensions; if no valid extension remains, use the fixed default list.

The extension grammar excludes slash, backslash, colon, whitespace, NUL/control bytes, repeated extension dots, and `.`/`..` traversal forms. Candidate containment is still checked after concatenation, so grammar validation is not the sole path boundary. Following an immediate-child executable symlink is deliberate standard PATH behavior; its presence is only an availability hint and does not grant trust or execution permission.

The provider performs filesystem metadata/access checks only. It does not invoke a shell, resolve aliases/functions, execute `--version`, read tool configuration, or return an absolute path to prompt content. `PATH` is untrusted availability evidence, not a trust grant; normal command permissions and safety rules still apply when the agent later elects to run a tool.

Doctor behavior must remain unchanged after the extraction. If its compatibility needs differ from the strict absolute-entry and bounded-`PATHEXT` runtime probe, expose explicit provider options and retain tests for the previous readiness results rather than silently changing them.

## Index and composition

In `cli/lib/skill-content.mjs`:

1. Parse and validate runtime appendices while building the in-memory index. Store them by canonical target address, then group, then command. Retain the validated group definition from the catalog in the index.
2. After all selectors are known, reject unknown targets and duplicate tuples. Include runtime appendix bodies in reference, fence, action/transport isolation, script, and staged-runtime validation.
3. Add `appendRuntimeGuidance(index, selection, availableCommands)`:
   - find groups attached to the resolved canonical selector;
   - visit group names in bytewise order, independent of JSON object insertion order;
   - within a group, visit commands in the catalog array order and ignore commands for which that selector has no authored appendix;
   - for `first-available`, append only the first authored candidate whose command is available;
   - for `all-available`, append every authored available candidate in catalog order;
   - append nothing when no candidate is available;
   - preserve selector owner, canonical selector, requested address, and base identity; record selected `{ group, command }` pairs on the returned selection for tests and diagnostics.
4. Compose bodies in this fixed order: base selector, detected agent-profile appendices, then runtime appendices. Join complete bodies with the existing single empty-line rule and keep one terminal newline.

In `cli/agentgear.mjs`, resolve every requested canonical address before probing or writing stdout. Collect only commands referenced by runtime appendices attached to those selections, observe their availability once for the invocation, and reuse that immutable set for every address and repetition. Then apply agent and runtime guidance and call the existing formatter. Unknown/ambiguous addresses must still fail atomically with no stdout; corrupt catalog or appendix metadata remains status 1.

Upstream skill retrieval remains unchanged and cannot be combined with canonical addresses, so it never enters runtime composition.

`agentgear skill list SKILL --json` should add an optional `runtimeGuidance` array to selector records that own runtime appendices. Each record reports the group, selection mode, and authored commands in catalog order. Text listing stays unchanged. Returned runtime fragments self-identify through their required headings and their authored first sentence, making both the available choices and the selected result auditable without injecting environment strings into canonical text.

## Refresh semantics

Ordinary selector bodies and agent appendices retain the existing remember-and-reuse contract. The two new dynamic entry skills are explicit exceptions:

- each `SKILL.md` tells the agent to run `agentgear skill get browse-web` or `agentgear skill get explore-code` at the start of every matching task turn, rather than only after forgetting remembered guidance;
- each `start` selector states that its availability result applies only to the current retrieval and must be refreshed again after a known `PATH` or tool-installation change;
- do not refresh before every command in the same turn.

The exception is local to those two bootstraps and selectors. Existing `SKILL.md` files, including `explore-defects`, keep the current stable reuse wording and receive no runtime appendices.

## First behavior skills and fragments

### `browse-web`

The complete base `start` selector covers ordinary page reading/navigation without depending on a detected command. It distinguishes static/public retrieval from rendered or interactive evidence, requires the smallest relevant access method, preserves normal credential/privacy/permission boundaries, and reports when available tooling cannot support the requested interaction. It directs browser application validation to the existing browser-test workflow instead of treating `curl` as equivalent.

Attach two concise runtime files to `browse-web/start`:

- `web-page` / `agent-browser`: prefer for rendered, interactive, or JavaScript-dependent pages; use its normal open/snapshot/interact flow and browser evidence. State that selection is an availability hint, not permission.
- `web-page` / `curl`: use only for static/public HTTP retrieval when the ranked browser candidate is unavailable; do not claim rendered DOM or interaction evidence, follow redirects/limits deliberately, and do not send credentials implicitly.

When both commands are present, output contains only the `agent-browser` fragment. When only `curl` is present, its fragment appears. When neither is detected, the complete base guidance remains and may use an independently supplied harness-native capability without claiming that Agentgear detected it.

### `explore-code`

The complete base `start` selector covers read-only exploration of an unfamiliar codebase: establish scope/question, start with a cheap structural and file map, narrow before full reads, trace only relationships relevant to the question, verify material conclusions in source/tests, and report evidence plus coverage gaps. It is not a defect-family analysis, code-health review, or authorization to edit.

Attach three concise runtime files to `explore-code/start`:

- `code-exploration` / `rg`: use for fast filename, literal, and identifier narrowing before deeper inspection.
- `code-exploration` / `ast-grep`: use for syntax-shaped queries and direct structural members; compose it with text search rather than treating it as a full dependency graph.
- `code-exploration` / `codegraph`: use for cross-file relationship, dependency, caller/callee, or ownership traversal; confirm material conclusions in source because graph freshness/completeness may vary.

Every available fragment is appended in catalog order. Missing one additive command removes only its own fragment. With none detected, ordinary file/text inspection remains a complete fallback.

## Documentation authority

Update all implementation-authority text in the same change:

- `skillUsage()` distinguishes stable base guidance from the two explicitly marked dynamic entry skills without causing unaffected skills to reload;
- `docs/ARCHITECTURE.md` records the catalog/provider/canonical-content ownership boundary, the new public entries, and the absence of generated prompt code or persisted environment state;
- `docs/PROGRESSIVE-SKILL-DISCLOSURE-DESIGN.md` is mandatory: update the exact public list from its stale fourteen-entry wording to the new 17-entry repository contract; revise canonical-content layout to include the third runtime-appendix document kind; revise its claim that the CLI knows only selectors and agent appendices; define selector-opt-in dynamic output and the local per-turn refresh exception to stable reuse; add catalog group ownership, PATH-only trust boundaries, composition/list-JSON behavior, unchanged output for existing selectors, validation/failure behavior, pack/build effects, and new acceptance tests;
- `skills/README.md` adds `browse-web` and `explore-code` as normal implicit behaviors and keeps `explore-defects` in the explicit-only list.

## Validation and failure behavior

Extend `validateCatalog()` to validate the optional group object, modes, exact command grammar, uniqueness, and non-empty lists. Existing catalog/directory equality validation enforces declaration of both new skills. Extend both source and staged selector-index validation so a release cannot publish invalid group references or appendix metadata.

Fail closed on authored/configuration corruption: unknown group, undeclared command, unsafe command name, duplicate tuple, unknown/cross-skill target, mixed document kinds, invalid guard heading, oversized content, workflow headers, broken references, or missing runtime scripts is a normal corrupt-index/status-1 error.

Fail open on optional environment evidence: missing `PATH`, no matching executable, an invalid individual `PATHEXT` segment, access denial, or a probe race yields the complete base selector with the affected appendix omitted. An oversized/over-segmented `PATHEXT` or one with no valid entries uses the bounded fixed default. No optional-tool absence changes exit status. If a selected tool disappears before execution, the agent reports/falls back using the base skill contract; Agentgear does not retry or select a different fragment after output has been emitted.

## Tests

Extend `tests/progressive-skill-disclosure.test.mjs` and provider-focused tests as needed:

1. Catalog validation accepts an absent map and the two valid groups; rejects unsafe/duplicate/empty commands, invalid group names, unknown modes, arrays/primitive definitions, and malformed pack command references.
2. The exact public-entry fixture and generated target layouts contain the 17 names above; `core` adds `browse-web` and `explore-code`; workflow/browser closures remain otherwise unchanged; the legacy migration whitelist does not add either name.
3. Both new skills have independently valid small bootstraps, `start` entry selectors, implicit Codex/Claude metadata, accurate concrete descriptions/default prompts, no runtime scripts, and no workflow dependency. Existing `explore-defects` files and output remain byte-identical.
4. Index fixtures accept valid runtime appendices and reject every corrupt case listed above, including action/transport headers and non-CommonMark guard indentation.
5. Unit composition proves ranked fallback, additive composition, bytewise group order, catalog command order, no-match base fallback, selector identity preservation, agent-before-runtime ordering, repeated-address consistency, and byte-identical existing selectors.
6. Availability tests use temporary absolute PATH directories and executable fixtures. Cover multiple PATH entries, duplicate hits, missing/non-executable/directory candidates, executable symlinks, ignored relative/empty entries, missing PATH, and probe errors.
7. Injected-Windows tests cover default extensions, a declared command that already has an extension, ASCII case normalization/deduplication, the 4096-byte/64-segment/32-accepted-entry bounds, and fallback when no valid extension remains. Hostile `PATHEXT` cases must include slash, backslash, drive-colon, whitespace, control/NUL, `.`/`..`, repeated-dot, separator/traversal payloads such as `..\\outside`, and an actual executable placed outside the PATH directory; assert that no rejected or containment-escaping candidate reaches metadata/access checks or affects composition.
8. CLI tests use controlled PATH values to prove `browse-web` all-present/browser-only/curl-fallback/none-present output and `explore-code` all-present/partial/none-present output. Also prove multi-address atomic failure emits no stdout and does not partially compose guidance.
9. `skill list browse-web --json` and `skill list explore-code --json` report their static runtime candidates while text listing remains selector-only.
10. Source checkout, staged physical release, shared current launcher, and copy-fallback retrieval retain the same composition result for the same controlled environment.
11. Existing doctor, upstream staging/retrieval, agent-profile appendix, selector formatting, content limits, action-template, authoritative install/reconciliation, and full build-layout tests remain green. Updating from the preceding release installs the two new owned entry links; rollback through the preceding release's authoritative default/pack reconciliation removes those matching owned links.
12. Documentation assertions or review fixtures cover the 17-entry list, third document kind, and local refresh exception in `docs/ARCHITECTURE.md`, `docs/PROGRESSIVE-SKILL-DISCLOSURE-DESIGN.md`, and `skills/README.md`, so the old global stable-output, two-kind, and fourteen-entry claims cannot remain.

Run `npm run check`; it must regenerate rather than hand-edit `dist/` and pass source validation plus the complete suite.

## Compatibility, rollout, and extension

The public discovery surface intentionally expands from the current 15 entries to 17. This is an additive user-visible behavior change, not a hidden host-dependent exposure change: both entries are always selected by `core`/default `all`, while only their returned optional fragments vary with PATH. Existing callers, selector addresses, text framing, exit codes, pack requirements, doctor results, existing skill output, and installation-state schema remain compatible. The new `skill list --json` field is additive.

There is no persistent environment state, prompt cache, network access, runtime script, permission grant, or new CLI flag. Normal install/update reconciliation creates the two new managed entry links. A rollback to the preceding release removes those exact matching owned links through its authoritative default/pack reconciliation; unmanaged or changed paths retain existing ownership protection.

Ship the catalog model, provider, index/composer, both behavior skills and fragments, validation, tests, `skillUsage()`, `docs/ARCHITECTURE.md`, `docs/PROGRESSIVE-SKILL-DISCLOSURE-DESIGN.md`, and `skills/README.md` in one release. Regenerate `dist/` only through the build/check path.

Future predicates such as tool versions, platform-specific variants beyond safe executable suffix lookup, MCP capabilities, repository facts, or working-directory facts require a new explicit catalog schema and trust review. They must not be smuggled into command names, `PATHEXT`, or Markdown templates. Additional selection modes are added only for a demonstrated policy that cannot be expressed as ranked-first or additive-all.
