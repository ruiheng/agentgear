# Progressive Skill Disclosure for Agentgear

## Status and goal

This design changes Agentgear from exposing the complete maintained skill collection to every harness into exposing a small public entry set while keeping the complete canonical collection in the managed Agentgear runtime. Detailed instructions are retrieved as small Markdown prompt slices through the existing agentgear launcher.

The design preserves these ownership boundaries:

- skills/<name>/ remains the only hand-authored source of agent-facing instructions and runtime scripts.
- Agentgear owns workflow routing, workflow-stage instructions, and closeout policy.
- Waypost remains the durable message transport and does not acquire Agentgear workflow documentation or routing behavior.
- The agent interprets and executes retrieved text. The CLI only indexes and returns documents; it does not execute a workflow, advance state, parse Waypost message bodies, or decide outcomes.

Success means a normal installation exposes exactly the accepted 17 public entry skills, route-waypost-action handles a received `Action: <value>` field independently of message retrieval, an inbound Action selects the first executable owning slice with one lookup unless a real discriminator is required, and any slice can be listed and fetched again through agentgear skill without knowing an installation path.

## Accepted requester decisions

The following product choices are authoritative for this design:

- The default installed and discoverable entry set is exactly 17 skills: assess-tech-design, browse-web, code-health-review, commit-staged, delegate-code-task, delegate-task, explain-for-me, explore-defects, fix-strategy, handoff, intent-framing, refactor-review, roundtable, route-waypost-action, search-files, simplify-review, and tech-design-workflow. Plan dispatch is the internal `multi-agent-protocol/internal/dispatch-plan` selector, not a canonical skill or public entry.
- The entry set remains declarative in catalog metadata so later adjustment is a catalog edit rather than an installer rewrite.
- Agentgear-managed skill links that are outside the effective pack and explicit-skill selection are removed by authoritative pack/default install, source-install, or update reconciliation.
- Installation provenance and a legacy-state migration are not added merely to preserve an ambiguous historical explicit prompt-only selection. The sole current user accepts that a later authoritative pack invocation can remove it unless it is repeated with --skill.
- Deletion never extends to an unmanaged path or a path that no longer matches Agentgear's ownership record.
- Legacy discovery entries left outside valid installation state are handled only by the explicit one-time migration command `agentgear migrate legacy-skills --apply`. Inside that command alone, exact membership in its fixed legacy-name whitelist is sufficient cleanup authority; no ordinary command inherits name-only ownership.
- Claude Code ordinary, uncompacted repeated Skill calls are not treated as repeatedly loading the complete skill. Post-compaction restoration is reasonable recovery behavior, not a defect or the primary motivation for this redesign.
- The upstream agent-deck skill is not installed or exposed by default. It remains explicitly retrievable through agentgear skill get agent-deck.
- The full canonical distribution depends on the matching Agentgear CLI/runtime and is not directly installable as a runnable skill collection.
- Canonical overview and slice retrieval use agentgear skill get <skill> [selector...]. There is no separate agentgear prompt namespace.
- A single invocation may retrieve multiple selectors in caller order, using the installed Waypost multi-topic text format adapted to Agentgear skill and selector labels.

## Current-state findings

The existing runtime already provides the central architectural primitive this change needs. stageRuntime() copies the repository, excluding only .git, node_modules, and dist, into an immutable managed release. Therefore every canonical skills/<name>/ directory is already present beside the installed agentgear launcher even when the installer exposes only a subset of skill directories to a harness. The skill content command can resolve content relative to its own runtime root and does not need an additional canonical-content installation, cache, or path-discovery mechanism.

The current pack resolver conflates two concepts: a skill included in a selected capability pack and a skill directory copied or linked into a harness discovery directory. That conflation is why the default all selection exposes all maintained skills. The implementation must separate pack capability selection from harness exposure.

Codex is the demonstrated repeated-context pressure: persistent sessions repeatedly reread shared skill references and provide no reference-cache guarantee. Claude Code 2.1.208 and 2.1.209 avoid full reinjection on ordinary uncompacted repeated Skill calls; material skill-body reinjection occurs during compact recovery. That behavior is reasonable. Small entries and slices still reduce recovery payload and give every harness the same explicit recovery mechanism, but the design must not describe Claude's normal Skill behavior as the same repeated-loading defect observed in Codex.

Commit 03c5528 usefully demonstrates that large technical-design skills can be split into shorter entries and owned references. Its incremental review evidence machinery is not part of this design: the per-file evidence recording API, reviewer evidence index, review ledger, machine state, and associated tests add a second stateful review subsystem and depend on file snapshots to infer validity. They do not advance progressive disclosure and must be removed. Useful reference splits may be retained and indexed as selectors.

## Architecture

### Canonical content layout

Every maintained skill directory remains present under skills/<name>/, with its existing scripts, agents metadata, assets, and other owned material. Agent-facing content is divided into four forms:

1. SKILL.md is a concise bootstrap for direct or compatibility installation. It identifies the first selector and tells the agent to remember and reuse the stable guidance returned by agentgear skill get. Reload occurs only when the agent no longer remembers the guidance, the user asks, or there is evidence it changed. Every SKILL.md, including a prompt-only skill installed explicitly, remains independently valid.
2. Markdown files below skills/<name>/references/ hold the detailed prompt slices. Existing reference directories are reused; no parallel prompt source tree is introduced.
3. An optional agent appendix adds best-effort guidance for one recognized harness profile without changing the target selector's identity or correctness.
4. An optional runtime appendix adds advisory guidance for one catalog-declared command that is ready in the current PATH/workspace. The selector remains complete without it, and a better built-in capability may take precedence.

A prompt slice opts into the runtime index with restricted frontmatter:

~~~markdown
---
skill-selector: author-round
selector-summary: Draft or revise one immutable design round and request review.
selector-aliases: action:design_spec_draft_requested, action:design_spec_context_corrected
---

# Author Round
...
~~~

Rules for this metadata:

- skill-selector is the stable selector local to the owning skill. It uses lowercase letters, digits, dots, underscores, hyphens, and slash.
- The canonical address is `<owning-skill>/<skill-selector>`; for example `agentgear skill get tech-design-workflow/author-round`.
- selector-summary is one non-empty line used by listing and diagnostics.
- selector-aliases is optional and contains comma-separated independent addresses such as `action:<token>` or `<skill>/<selector>`. Aliases use letters, digits, dot, underscore, hyphen, slash, and colon, contain no whitespace, and their complete address is at most 256 bytes.
- Canonical addresses and alias addresses are globally unique and at most 256 bytes. A bare alias must resolve to one canonical slice after canonical-selector and alias-suffix matching. Validation and runtime lookup fail on duplicates, alias/canonical collisions, skill-entry shadowing, or bare-address ambiguity.
- File location below references/ is not an API. A file may move within its owning skill without changing its selector.
- Prompt bodies refer to other prompt content with independent addresses, for example `agentgear skill get multi-agent-protocol/session-host tech-design-workflow/report-handling`, never by an installation-specific path.
- Prompt bodies may refer to runtime scripts only through the existing agentgear run <skill> <script> form.
- The skill command removes the metadata frontmatter and returns only the Markdown body in normal single-selector text mode.

An alias is declared on the prompt slice it resolves to; no central action-to-file manifest is introduced. This lets an owning workflow slice declare `action:<token>` and resolve the receiver's one lookup directly to that body. The CLI resolves it through the same global unique-selector fallback as any other bare address.

Every Agentgear-owned canonical skills/<name>/SKILL.md must be at most 2 KiB. Each indexed prompt slice must be at most 8 KiB. Limits are byte-based and deterministic. Large current canonical skills are split by stable action or execution stage until they meet the slice limit. These limits do not apply to the separately retrieved upstream agent-deck payload; they apply only to Agentgear-owned canonical agent-facing text, not scripts or maintainer documentation.

### Skill content CLI

Add one skill-centric retrieval namespace to the existing launcher:

~~~text
agentgear skill get ADDRESS...
agentgear skill list [SKILL] [--json]
agentgear action list [--json]
~~~

There is no agentgear prompt command.

Each positional argument is one independent address. Options may appear before the addresses. The parser retains the conventional `--` option boundary for compatibility, but help and agent-facing instructions omit it because every valid address begins with an alphanumeric character.

An address equal to an Agentgear-owned skill name resolves to that skill's entry selector. An address containing `/` resolves the exact canonical or alias address. Any other address searches canonical selectors and aliases across all skills: one match succeeds, no match fails, and multiple matches fail with the fully qualified candidates. Every argument is resolved independently, so one invocation may combine slices from different skills.

Text formatting mirrors the installed Waypost doc contract:

- one address: write its plain prompt body with no label;
- two or more addresses: preserve argument order and repetitions; for each requested address write `agentgear skill: <ADDRESS>`, then every body line indented by two spaces; separate blocks with exactly one empty line and end the combined output with one newline;
- resolve and read all addresses before writing stdout; any unknown or ambiguous address fails atomically with no partial stdout.

The exact multi-address label is `agentgear skill: <REQUESTED_ADDRESS>`. It names what the caller requested, even when an alias or global fallback resolves to content owned elsewhere.

Frontmatter is never included in a returned prompt body. Each body otherwise remains unchanged except for normalizing to one trailing newline. The multiple-selector formatter trims that final newline before indenting, including blank lines as two-space lines.

An owning skill may add best-effort agent guidance without changing the selector address or its base body. A Markdown file below that skill's `references/` directory declares exactly `agent` and `append-to-selector` in frontmatter. When the runtime recognizes the native command environment for that agent, it appends the file's body to the addressed base selector with one empty line between them. Detection failure returns the complete base selector unchanged. An appendix begins with a protective `## For <Agent> only` heading, cannot declare selector aliases or message headers, and must never be required for workflow correctness. The `--agent-profile` option exists only as a deterministic test and diagnostic override; normal prompt instructions do not pass it.

An owning selector may also declare runtime appendices with `runtime-command` and `append-to-selector` frontmatter. The catalog defines the finite command registry and supported readiness predicates. Every ready authored candidate is independent and advisory; optional-tool absence returns the complete base selector, and unrelated selectors remain byte-identical. `codegraph` additionally requires an existing workspace index; detection never creates one. The complete contract is specified in `docs/ENVIRONMENT-ADAPTIVE-SKILL-GUIDANCE.md`.

skill list is the separate deterministic skill discovery operation. Without a skill name, text mode writes every canonical and upstream-retrievable skill name, one per line; JSON mode returns their catalog records. With a skill name, text mode writes every canonical address and alias owned by that skill, one per line in bytewise order. action list writes every registered global `action:<token>` address; its JSON records include action, address, owner, canonical selector, and summary. Local addresses are qualified so every listed value can be passed directly to skill get; global aliases remain bare. Selector listing accepts no query, returns an empty success for a skill with no selectors, and performs no fuzzy matching. Its JSON mode returns ordered records with requested skill, address in the selector field, canonical owner, canonical selector, aliases, and summary.

Unknown or ambiguous addresses exit status 2 with a concise diagnostic, up to three deterministic similarity-ranked candidates, and a directly executable discovery or selector-listing command. Candidates are diagnostic only: resolution remains exact, and unknown Action aliases are never silently corrected. Corrupt or duplicate runtime metadata exits status 1. Neither operation accepts a filesystem path, glob, URL, Waypost body, workflow state, or execution arguments.

The selector index is built in memory for each command invocation by scanning skills/*/references/**/*.md below the runtime root containing the CLI. Traversal is contained, symlink-free, and deterministic. There is no generated index and no persistent cache. Source checkouts, staged physical releases, shared current launchers, and copy-fallback wrappers therefore use the same content model.

The command remains generic. It knows skills, selectors, aliases, bodies, optional agent appendices, and declarative runtime appendices. It does not parse message bodies, branch on roles or workflow modes, expand dependencies, call Waypost, create sessions, execute candidate commands, or interpret an action. It returns only the explicitly requested addresses, with best-effort agent guidance and ready advisory runtime candidates appended when applicable.

### Complete action contract and direct routing

The set of indexed selector-aliases beginning with `action:` is the sole declaration of supported inbound Waypost actions. A token is supported only when exactly one indexed slice owns that alias.

An action alias maps directly to the first executable selector owned by the workflow that handles it. It does not normally map to a receiver-owned forwarding slice. A tiny routing selector is used only when data in the already received message genuinely selects different behavior.

The initial action-alias set is complete for the current workflow surface:

| Action token | First selector address | Why a router is or is not needed |
| --- | --- | --- |
| browser_check_report | browser-test/report-route | Branches between a matching active review and a direct requester report. |
| browser_check_requested | browser-test/check-request | Direct execution. |
| browser_setup_provided | browser-test/setup-provided | Direct execution. |
| browser_setup_requested | browser-test/setup-request | Direct execution. |
| closeout_delivered | planner-closeout/run | Direct execution. |
| code_delivery_complete | planner-closeout/run | Direct execution with action-specific checks inside the owning selector. |
| code_health_review_report | code-health-review/report-received | Direct result delivery. |
| code_health_review_requested | code-health-review/review | Direct execution. |
| delegated_task_result | delegate-task/result | Direct result handling. |
| design_prune_context | prune-tech-design/start | Direct pruner context intake. |
| design_prune_report | tech-design-workflow/report-handling | Direct result handling by the request sender. |
| design_prune_requested | prune-tech-design/start | Direct pruner execution. |
| design_spec_context_corrected | tech-design-workflow/author-round | Direct author execution. |
| design_spec_delivered | tech-design-workflow/requester-delivery | Direct requester closeout. |
| design_spec_draft_requested | tech-design-workflow/author-round | Direct author execution. |
| design_spec_review_context | review-tech-design/context-intake | Direct reviewer context intake. |
| design_spec_review_context_rejected | tech-design-workflow/context-correction | Direct correction by the context sender. |
| design_spec_review_report | tech-design-workflow/report-handling | Direct author or review-existing requester handling. |
| design_spec_review_requested | review-tech-design/review-request-route | Selects draft-round from Lane State or committed-docs from the inline target. |
| execute_delegate_task | delegate-code-task/execute | Direct coder execution. |
| execute_delegated_task | delegate-task/execute | Direct non-code worker execution. |
| execute_plan | execute-plan/start | Direct planner execution. |
| group_message_available | route-waypost-action/group-route | Branches on Group-Address and As-Person; roundtable is one branch. |
| message_rejected | multi-agent-protocol/message-rejected | Handles a workflow-level rejection of one outbound delivery without replying to the rejection. |
| plan_report_delivered | plan-report/receive | Direct supervisor handling. |
| refactor_review_report | refactor-review/report-received | Direct result delivery. |
| refactor_review_requested | refactor-review/review | Direct execution. |
| review_requested | review-code/review | Direct review execution. |
| review_task_context | review-code/task-context | Direct context intake. |
| rework_required | review-code/result-route | Branches on task, integration-final, standalone, and matching plan context. |
| roundtable_participant_turn | roundtable-participant/turn | Direct participant execution. |
| simplify_review_report | simplify-review/report-received | Direct result delivery. |
| simplify_review_requested | simplify-review/review | Direct execution. |
| abort_iteration | review-code/result-route | Routes an iteration stop to the planner for planned lanes, or the requester for standalone review. |
| work_accepted | review-code/result-route | Routes an accepted implementation to the planner for planned lanes, or the requester for standalone review. |

The action set deliberately excludes retired review_completed and other unsupported legacy actions. Adding, renaming, or removing an action requires changing the owning slice's selector-aliases metadata and any producer template in the same change.

Validation collects every exact Action: <token> line in indexed selector bodies. JavaScript Waypost senders are an explicit producer boundary instead of a source-text heuristic: every skill-owned sender that writes a Waypost --body-file must be named in its owning action-producers.json manifest, and each manifest entry declares one alias-registered token, an explicit `sticky` boolean, exact script, factory export, and sender export. The shared helper snapshots each caller-supplied header name and value exactly once into primitive locals, constructs the initial envelope from those structured `{ name, value }` snapshots, inserts the one declared `Action` itself, rejects caller-supplied `Action`, transport-owned `From`/`To`, duplicate header names (case-insensitively), and empty or CR/LF/NUL header values, then appends a separately supplied body. For a `sticky: true` declaration it also appends the exact final line `Keep this task context across compaction.` so the optional Agentgear Codex hook can preserve the received task context; notification-only declarations remain `sticky: false`. Indexed prompt validation likewise rejects physical `From:` or `To:` template lines. Waypost delivery `sender_address` and `recipient_address` own reply routing; session identities appear only as action-specific task data when continuity, ownership, or cleanup needs them. Header-bound provider values remain opaque apart from that envelope-safety rule; existing path or provider validators retain their own authority. Its manifest-bound sender closure unwraps only a message branded for that exact declaration; callers cannot supply a module URL to claim a different sender. Raw strings, copied objects, and computed tokens cannot become an Action header or reach the declared sender path. Dynamic, placeholder, duplicate-choice, or shell-expanded Action values are invalid at the producer boundary; conditional outputs use separately declared exact values. Generic protocol prose must describe the header without an Action: placeholder line. Transport-originated actions such as group_message_available may be registered without a local producer. Tests assert the full declared producer set against the aliases, not a representative subset.

This validation is static documentation and template consistency checking. The CLI still does not interpret or emit workflow messages, and no central routing manifest duplicates the owning slice metadata.

### Received Action routing

route-waypost-action/SKILL.md is directly installed and fits within the 2 KiB bootstrap budget. Its discovery description defines an Action field as a line in the received Waypost message written `Action: <value>`, where `<value>` names registered Agentgear instructions. Message retrieval remains discoverable from the Waypost MCP and CLI and is not duplicated as an Agentgear skill.

After loading, the skill retrieves `agentgear skill get action:<value>` and follows the returned owning selector. The Agentgear CLI owns selector validation and lookup errors. The prompt does not parse the value, define a token grammar, classify malformed fields, or implement a rejection protocol. If lookup fails, the router does not guess another workflow; the Receiver Contract fails any associated claim as a routing failure.

### Small installed entries

Add a required exposure field to every canonical skill record:

~~~json
"route-waypost-action": {
  "tags": ["workflow", "receiver", "routing"],
  "exposure": "entry"
}
~~~

Allowed values are:

- entry: included in harness discovery when a containing pack is selected.
- prompt-only: retained in the canonical runtime and selector index, but not exposed by pack selection.

The exact accepted entry set is:

- assess-tech-design
- browse-web
- code-health-review
- commit-staged
- delegate-code-task
- delegate-task
- explain-for-me
- explore-defects
- fix-strategy
- handoff
- intent-framing
- refactor-review
- roundtable
- route-waypost-action
- search-files
- simplify-review
- tech-design-workflow

The remaining current canonical skills are prompt-only: browser-test, browser-test-request, execute-plan, multi-agent-protocol, plan-report, planner-closeout, review-closeout, review-code, review-request, review-tech-design, and roundtable-participant. The supervisor-to-planner instructions live under `multi-agent-protocol` as `multi-agent-protocol/internal/dispatch-plan`, and the refactor-review request contract lives under `refactor-review` as `refactor-review/internal/request`; neither internal protocol has an independent skill entry or bare selector.

The choice preserves the directly useful advisory reviews while keeping request helpers, persistent worker handlers, and receiver-selected workflow stages out of default discovery. It exists only in per-skill exposure metadata; there is no second entry-name array in implementation code. The list above is the accepted product contract and its test expectation.

The pinned upstream Agent Deck skill is not a public entry and is never copied or linked into a harness discovery target by default or pack selection. Its current approximately 61 KiB SKILL.md would violate both the exact 17-name product decision and the minimal-disclosure goal.

The upstream payload may still be provisioned while staging a new immutable managed runtime when selected session-host requirements need it. Internal staging does not create a target skill record and does not make the upstream skill discoverable. Existing Agentgear-managed target records for agent-deck are outside the new desired exposure set and are withdrawn by the same authoritative reconciliation and ownership guards as other obsolete managed links.

The same skill get namespace handles the catalog-declared upstream agent-deck skill. It has no indexed selectors in this release; its skill-name address returns the upstream overview plus a usable resource base, while skill list agent-deck returns an empty list.

An upstream declaration has two distinct identities: its catalog object key is an internal identifier used by session-host references and pin verification, while the basename of `skillPath` is its public skill address. Listing, selector discovery, retrieval, persisted materialization names, and prompt-reference validation all resolve through that public address. Catalog validation rejects duplicate public upstream addresses and collisions with canonical skill names; it does not require the internal identifier to equal the public address or require an explicitly retrievable upstream to belong to a session host.

For agent-deck:

- skill get accepts the catalog-declared upstream name as a lone address; an upstream sub-address or combination is unknown and fails status 2.
- It materializes the complete verified upstream skill tree in a content-addressed, non-discovery resource store at <data-root>/retrieved-skills/agent-deck/<digest-hex>/payload. This path is outside every harness target and every runtime release.
- A sibling manifest records schema version, upstream name, repository, ref, commit, content digest, and payload-relative SKILL.md. The digest-hex path component is the 64-character suffix of the catalog contentDigest and is safe on every supported platform.
- On each get, validate an existing materialization's manifest and complete tree digest. If absent, first reuse an already staged copy from a current or retained immutable runtime only when that runtime's catalog pin matches and the payload passes digest verification. Otherwise perform the existing sparse pinned fetch in a temporary checkout.
- Copy the complete verified tree into a same-parent temporary materialization, verify it again, write the manifest, and atomically rename it into the final content-addressed path. Never write into a published immutable runtime. If a concurrent creator wins the rename, accept its result only after revalidation.
- Text mode prepends the minimum launcher-controlled resource context required by this multi-file upstream skill: Base directory for this skill: <absolute payload path>. It then writes the exact upstream SKILL.md body with one trailing newline. This is not a generic address wrapper; it supplies the same base-directory fact the upstream instructions require for relative references and scripts.
- It does not copy or link the skill into any harness target, add an installation-state target record, alter exposure selection, or index third-party resources as canonical selectors.
- Unknown or non-upstream skill names exit status 2. Fetch, digest, or runtime corruption fails status 1.
- Because first materialization may require the network, it uses the existing upstream-fetch trust and permission boundary. A verified materialization is durable and offline-retrievable.
- If the final content-addressed path or manifest exists but fails validation, do not overwrite or delete it automatically. Fail with the exact path and remediation guidance.

The retrieved-skills root is Agentgear-owned persisted data, not prompt cache or installation state. It has a self-authenticating ownership contract independent of versioned installation state: each purge candidate must be exactly `<data-root>/retrieved-skills/<catalog-upstream-name>/<64-lowercase-hex-digest>`, be a real directory reached without symlinks, and contain the Agentgear retrieval manifest whose upstream name, repository, ref, commit, contentDigest, payload-relative SKILL.md, and complete payload digest match the current catalog upstream declaration and the digest-named directory. Directory names, a SKILL.md file, or marker-shaped data alone never establish ordinary purge ownership. Discovery scans only direct upstream-name and digest children under this fixed root, rejects symlinks and deeper or unexpected shapes, and never follows a manifest-supplied path outside the candidate. A materialization from an older pin that the current catalog cannot verify is preserved and reported; ordinary purge does not acquire a historical pin catalog or use name-only authority to remove it.

`agentgear uninstall --purge` applies these exact modes:

- A full purge is an invocation without `--target`, `--dest`, or project-scoped target selection. It preflights every supported-state target/runtime candidate when state exists and every discovered retrieved-skill candidate whether state exists or not. A retrieval-only installation with no state is therefore not an early no-op: unchanged verified materializations are removed, empty retrieved-skills directories are pruned, and success is reported. If neither state-owned artifacts nor retrieved candidates exist, the existing no-state no-op message remains appropriate. If state is null but managed runtime markers or `current` exist, preserve the existing coherence failure and do not use retrieved-skill cleanup to legitimize or remove that ambiguous runtime data.
- A target-limited purge removes only the selected target records and their verified owned links or copies. It never removes or preflights global retrieved-skills data, even when the selected target is the last managed target and normal runtime teardown consequently occurs. The materialization remains available because retrieval ownership is global rather than target-scoped; removing it requires a later full purge.
- For a full purge, a verified unchanged materialization is added to the removal plan. A candidate with a missing, corrupt, historically unknown, or ownership-mismatched manifest, a mismatched payload digest, a symlink, or unexpected contents is preserved and reported with its exact path as `preserved unverifiable retrieved skill`; it is never overwritten or deleted by `--force`.

Purge uses two independent ownership domains. Existing target/runtime ambiguity keeps its current fail-before-mutation behavior so external target links and the shared runtime are not partially deleted. Retrieved-skill ambiguity does not block unrelated verified target/runtime deletion: changed or corrupt materializations are preserved and reported while other owned artifacts are removed. After all planned removals, any preserved retrieved candidate makes the full command finish with status 1 and `Purge incomplete: retrieved skill materialization requires manual cleanup`; otherwise it finishes with status 0. Removal of verified retrieved materializations occurs only after target/runtime preflight succeeds and the existing target/runtime mutation and state save or state removal have completed. Each retrieved candidate uses a same-parent quarantine rename before recursive deletion. If that deletion fails, restore the quarantine entry to its original path when possible, report the exact residual path, and exit 1. This ordering keeps versioned state consistent with completed target/runtime removals and gives retrieved resources per-candidate rollback; the design adds no persistent transaction log or promise of cross-domain rollback after target/runtime teardown has succeeded.

Ordinary install, update, source-install, pack uninstall, skill uninstall, and target-limited purge do not remove retrieved materializations, so explicit retrieval remains usable until a successful full purge.

This command satisfies explicit access without making host availability silently change the installed public surface. If a later product need requires installing agent-deck into harness discovery, that is a separate interface and decision.

Every entry SKILL.md states when it applies, names the first exact selector to retrieve, tells the agent to follow the returned text, and explains that the command can be repeated after compaction. It must not instruct the agent to open local references paths.

### Catalog selection model

resolveSelection() returns distinct concepts:

- packs: resolved pack closure.
- explicitSkills: exact --skill names supplied by the caller.
- capabilitySkills: every canonical skill reached through the selected pack closure plus explicitSkills.
- exposedSkills: entry skills reached through selected packs plus every explicitSkills member regardless of exposure.
- requirements: commands, upstreams, and session hosts derived from selected packs.

selectedInstallableSkills() returns exposedSkills only. Runtime staging still includes the complete canonical repository and may contain a verified pinned upstream host payload when selected host requirements need it, so prompt-only canonical capabilities remain available through skill selector lookup without installing their directories into harness discovery roots. Upstream payloads are not included in the canonical selector index.

Selection behavior is exact:

- With no --pack or --skill, all is selected as today, and exactly the 17 accepted canonical entries are exposed.
- --pack NAME exposes entry members of that pack closure.
- --skill NAME explicitly exposes that named skill even when it is prompt-only.
- --pack NAME --skill NAME exposes the pack entries plus the explicit skill.
- An explicit-skill-only install remains additive.
- A default or explicit-pack install, source-install, or update is authoritative for the selected targets and reconciles them to selectedInstallableSkills.

Pack descriptions change so all means all maintained capabilities, not every skill directory exposed to a harness. Workflow and browser readiness requires Waypost 0.6.0 or newer and one alternative session host; upstream documentation is no longer a target-installation readiness requirement. `agentgear list --json` reports each skill's exposure; selector discovery belongs to `agentgear skill list` rather than treating aliases as skills.

Catalog schemaVersion remains 1 because exposure is an internal additive field consumed atomically by this release. The updated validator requires a valid exposure for every canonical skill. Selector aliases stay with canonical agent-facing slices rather than becoming catalog product metadata.

### Doctor and readiness

`agentgear doctor` separates executable readiness from optional upstream documentation availability:

- Required pack commands retain their existing `ok` or `missing` checks and affect exit status. For Waypost, doctor additionally runs `waypost --version` and requires a valid version of at least 0.6.0; it does not start MCP or probe behavior.
- Each alternative session host prints only its external executable state, for example `ok      session host agent-deck (agent-deck)` or `unavailable session host agent-deck (agent-deck)`. At least one declared host must be available for workflow and browser readiness, exactly as today.
- A host's catalog `upstream` field describes optional documentation for explicit skill retrieval; it no longer causes a lookup under any harness target and is not counted in the missing-requirement total. The separate `requirements.upstreams` loop is removed for this catalog because packs do not require an installed upstream skill.
- For Agent Deck, doctor validates documentation without network access. It searches the current verified catalog digest first in `<data-root>/retrieved-skills/agent-deck/<digest-hex>/payload`, then in the current or retained immutable runtimes whose embedded catalog pin matches. It prints exactly one informational state: `ok      optional documentation agent-deck (verified local resource)`, `available optional documentation agent-deck (run: agentgear skill get agent-deck)`, or `warning optional documentation agent-deck (unverifiable local resource: <path>)`. `available` means no verified local copy is present and never triggers a fetch. `warning` reports corruption but does not make an otherwise ready host fail; explicit `skill get` and full purge retain their stricter validation behavior.
- Doctor never prints `missing` or `provision` for `<target>/agent-deck/SKILL.md`, never recommends installing or linking agent-deck into a harness, and never counts optional documentation toward readiness. With Agent Deck on PATH and no local payload, workflow doctor succeeds and reports the explicit retrieval command. With only Thurbox available, workflow doctor succeeds without requiring Agent Deck documentation.

The catalog continues to declare the pinned upstream under the Agent Deck session host so staging and explicit retrieval can share one trust anchor. Documentation status is derived from that host declaration rather than adding a second pack requirement or another skill exposure.

### Hard-cut installation reconciliation

This reconciliation adds no provenance field or state migration of its own;
the installation-state versioning contract is defined in
`docs/RUNTIME-OWNERSHIP.md`.

For install, source-install, or update on selected targets:

- If the invocation selects any pack, including the implicit default all, compute desired managed skill names as selectedInstallableSkills.
- Compare every recorded Agentgear-managed skill on each selected target with that desired set.
- A recorded active skill outside the desired set is withdrawn, whether it was historically installed by a pack or by an explicit --skill. This current-invocation authority is intentional and requester-approved.
- An explicit-skill-only invocation does not run withdrawal reconciliation and remains additive.

Withdrawal preflight uses existing ownership records:

- If the destination is absent, remove the stale state record.
- If a linked destination exactly resolves to the source recorded in supported state, remove the link transactionally and remove its record. The record may point at the managed current runtime path whose target changes during publication; ownership is the exact recorded link target, not a content comparison.
- If a copied destination still matches its recorded fingerprint, it may be removed transactionally under the same managed-path rule, although the current user normally uses links.
- If a destination exists but no longer matches its record, do not remove it and do not silently declare reconciliation successful. Fail preflight with the exact path and leave filesystem and state unchanged. --force does not broaden withdrawal to an unowned path.
- Never inspect or delete an unmanaged directory merely because its name matches a catalog skill.

All owned withdrawals participate in the existing install transaction with new entry installation, launcher publication, and state saving. A later failure restores removed links or copies and the preceding state.

uninstall has separate exact semantics:

- uninstall --skill NAME removes only that recorded managed name, subject to existing ownership checks.
- uninstall --pack NAME computes the selected pack closure's capabilitySkills, not exposedSkills, and removes every matching recorded managed canonical skill. This intentionally catches prompt-only directories recorded by a pre-change full-pack installation.
- A selected pack that requires a session host with a catalog upstream also includes that upstream's historical target name in the uninstall cleanup set, even though it is no longer exposed by current selection. Thus uninstall --pack workflow, browser, or all removes a matching legacy Agentgear-managed agent-deck target record.
- uninstall --pack all removes every recorded maintained canonical skill, including legacy prompt-only records, plus matching historical managed upstream exposure records.
- Mixed pack and skill selectors remove their union.
- A mismatched or unmanaged path is never deleted.

These rules close the legacy gap where upgrading the catalog before running uninstall could otherwise leave the old full skill set partially installed.

The installer prints every withdrawn name and a final notice to restart existing agent sessions so discovery and permission state reload. The removed `dispatch-plan` and `refactor-review-request` skill names are listed in `retiredSkills`, allowing owned historical discovery entries to be reconciled while their internal selectors remain available through their owning canonical skills.

--no-launcher remains supported only for users who already provide a compatible agentgear command. Help and completion output state that every bootstrap entry requires agentgear skill get. The installer warns when --no-launcher is combined with exposed Agentgear entries and does not attempt to adopt an unrelated launcher.

### One-time legacy skill migration

Add one exceptional public subcommand:

~~~text
agentgear migrate legacy-skills [--target NAME[,NAME] | --dest DIR] [--scope global|project] [--project DIR] [--apply]
~~~

This command exists only for the sole current user to clean pre-state or state-lost Agentgear discovery entries once on each machine, before installing the new release. It is deliberately not part of install, source-install, update, uninstall, purge, or retrieval. It accepts no `--pack`, `--skill`, `--force`, or arbitrary skill-name argument. Without `--apply` it is a read-only dry run. Its dedicated help and the first output line say `EXCEPTIONAL ONE-TIME MIGRATION: name whitelist is deletion authority`; the top-level command list labels `migrate legacy-skills` as an exceptional one-time cleanup and does not suggest it as routine maintenance.

Before resolving roots, the command reads and validates the normal installation state. It proceeds only when the state file is absent. A valid non-null schema-v2 or schema-v3 state exits 1 without scanning or mutation and says `Legacy skill migration refused: recorded Agentgear installation exists; use install/update/uninstall ownership reconciliation.` A malformed, unsupported, or unreadable state also exits 1 without scanning or mutation and reports the existing state path and validation error. The migration never edits or removes state, the launcher, commands, managed runtimes, retrieved-skills, or permission files. This precondition prevents name-only cleanup from deleting a current entry while leaving its ownership record behind; state-lost runtime ambiguity remains a separate manual recovery concern.

The whitelist is a release-owned constant in `cli/lib/legacy-skill-migration.mjs`, exported for validation and tests and not derived from the mutable active catalog at runtime. It contains exactly these 36 bytewise-sorted names Agentgear may have placed in harness discovery before this release:

~~~text
agent-deck
agent-deck-workflow
assess-design-spec
assess-tech-design
browser-test
browser-test-request
check-waypost-messages
code-health-review
commit-staged
coordinate-design-spec
delegate-code-task
delegate-task
dispatch-plan
execute-plan
explain-for-me
explore-defects
fix-strategy
handoff
multi-agent-protocol
plan-report
planner-closeout
refactor-review
refactor-review-request
review-closeout
review-code
review-design-spec
review-request
review-tech-design
roundtable
roundtable-participant
simplify-review
tech-design-assessment
tech-design-review
tech-design-review-request
tech-design-review-workflow
tech-design-workflow
~~~

This is the 27 canonical names that existed before `browse-web` and `search-files`, the formerly exposed upstream `agent-deck`, and the eight current `catalog/skills.json` retired names. The two newer skills were never installed by a preceding release and are deliberately absent. Validation requires every entry to match the safe skill-name grammar, remain bytewise sorted and unique, and equal a checked-in test fixture. Adding a name is a security-sensitive code change; catalog additions do not silently widen this command.

Target resolution is bounded and explicit:

- With no target options, inspect only the catalog's three global harness roots: `~/.agents/skills`, `~/.claude/skills`, and `~/.kiro/skills`. Unlike install defaults, the migration includes Kiro because this is machine cleanup of every supported historical global target. Default roots are resolved from the current environment and catalog; the whitelist remains code-fixed.
- `--target` selects only catalog-declared target names through the existing resolver. `--scope project --project DIR` resolves only those catalog-declared project-relative roots below the resolved project directory.
- `--dest DIR` is allowed only with the general target semantics, exactly one explicit destination, and an absolute normalized root. It cannot be combined with `--target` or project scope.
- Duplicate roots after normalization are inspected once. The command never reads installation-state target records to discover additional roots, never scans a home or project recursively, and never follows target-root symlinks. A missing target root is an empty success for that root.

For each selected real-directory root, read only its immediate children. A candidate is eligible only when its basename exactly equals one whitelist member, `path.dirname(path.resolve(root, basename))` equals the resolved root, and `lstat` of the candidate itself succeeds. Dot entries, nested paths, separators, case variants, Unicode lookalikes, and non-whitelisted names are outside authority. The command does not inspect a candidate's contents to infer ownership. A whitelisted immediate child may be a symlink, regular file, or directory; the migration removes the child entry itself without following it. The selected target root must be a real directory and not a symlink; an unsafe or unreadable root is an error and nothing is deleted anywhere in that invocation. On Windows, junctions and other reparse-point children are treated as link entries and unlinked without traversal; roots that are reparse points are rejected.

Execution is preflight-then-apply across the full selected scope. Dry-run prints deterministic bytewise-sorted records as `would remove legacy skill: <absolute path>` and ends with `Legacy skill migration dry run: <N> candidate(s); rerun with --apply.` Non-whitelisted children are never enumerated in normal output and remain untouched. Apply rechecks that installation state is still absent, then completes the same containment and `lstat` preflight for every root and candidate; any state or root-level error aborts with status 1 and no mutation. It uses the existing path-backup transaction semantics to rename every candidate to a unique same-parent quarantine entry without following symlink targets. Only after every candidate has been quarantined does it commit by recursively removing backups. A quarantine-rename failure rolls all earlier renames back and exits 1 with no removals. Backup deletion is best effort like the existing install transaction: a residual backup is reported with its exact path and status 1, while already deleted candidates remain removed; no completion marker is written.

A successful apply prints one `removed legacy skill: <absolute path>` line per candidate followed by `Legacy skill migration complete: <N> removed.` It exits 0 when candidates were removed or when none exist. Running it again is therefore idempotent and prints `Legacy skill migration complete: 0 removed.` No marker, state record, provenance, adopted ownership, or historical digest data is created; once-per-machine is an operator procedure, not persistent workflow state. JSON output is out of scope for this one-time command. Any parse error, unsafe root, enumeration error, containment failure, rename failure, backup-removal failure, or rollback failure exits 1; dry-run and successful apply exit 0.

This name-only authority ends at the migration module boundary. Ordinary reconciliation and uninstall still require supported state records and exact destination verification; purge still requires its runtime, target, or current retrieved-manifest ownership proofs; `agentgear skill get` still verifies catalog pins and content digests. Shared deletion helpers must accept an explicit migration-authority token or remain private to the migration module so future callers cannot accidentally reuse whitelist-only deletion.

### Build and distribution

scripts/build.mjs remains a thin wrapper over the CLI build command. Build output changes as follows:

- dist/universal/skills/ contains the complete canonical skills tree as source material for packaging, auditing, and downstream transformation only. It is explicitly not a runnable installed skill collection.
- Each harness target layout under dist/<target>/ contains exactly the catalog entry set in its skill discovery directory.
- Target layouts do not duplicate prompt-only content; the installed Agentgear runtime is the selector-content provider.
- Build never writes canonical selector source or a generated selector index. It copies canonical files and may generate only existing build metadata.

Every generated dist/universal/README.md states that the skills subtree is non-runnable source material: its compact bootstraps require the matching same-release Agentgear launcher and runtime. It directs executable consumers to install the npm package or run the normal Agentgear installer, which publishes one coherent runtime snapshot plus launcher and target entries. The universal tree has no supported copy-to-harness procedure.

The npm package plus its installed/staged runtime is the coherent executable distribution: it includes the complete canonical skills tree, catalog, CLI, and installer/runtime code in one versioned release, so selector content and aliases are beside the matching launcher. A verified upstream payload may be staged during install, reused from an immutable runtime, or materialized in the non-discovery retrieved-skills store for explicit retrieval. Direct copying of either dist/universal/skills or a target-specific dist layout is not a supported workflow installation.

### Validation and runtime-script integrity

Create cli/lib/skill-content.mjs as the shared contained indexer and formatter used by agentgear skill get/list, source validation, staged-runtime validation, and build tests. It returns canonical skill/selector pairs, reverse alias addresses, bodies, owners, referenced selectors, and documented runtime-script targets.

scripts/validate.mjs and catalog validation enforce:

- every canonical skill has exactly one valid exposure value;
- every Agentgear-owned canonical SKILL.md is at most 2 KiB and remains valid for explicit installation; the separately retrieved upstream agent-deck SKILL.md is outside this limit;
- every indexed selector is a real regular Markdown file below its owning references tree, has exact required frontmatter, has a unique owner/selector address, and is at most 8 KiB;
- selector-aliases values are fully qualified, safe, globally unique, and collision-free with canonical addresses;
- every action alias has a token matching [A-Za-z0-9][A-Za-z0-9_.-]{0,127};
- every exact action emitted in indexed selector templates or skill-owned JavaScript is registered, and executable templates contain no dynamic or placeholder Action values;
- every exact agentgear skill get <skill> <selector...> reference resolves;
- every catalog pack resolves, every pack member appears in capabilitySkills, and target exposure derives only from exposure metadata;
- target build layouts contain exactly the 17 entry skills while universal contains every canonical skill;
- no default or pack target layout contains agent-deck, while agentgear skill get agent-deck resolves only the pinned verified upstream payload;
- runtime scripts remain JavaScript/Node.js and remain inside their owning skill.

All indexed selector slices are considered reachable for runtime validation because skill list/get intentionally exposes the complete canonical selector collection. The implementation therefore does not need a fragile graph rooted only in installed SKILL.md references.

For every SKILL.md and indexed selector body, the shared indexer recognizes exact agentgear run <skill> <script.js|mjs|cjs> references. It validates that:

- the named skill exists in the catalog;
- the script path is relative, contains no parent traversal, and resolves under skills/<skill>/scripts/;
- every path component is contained and symlink-free and the leaf is a regular JavaScript file;
- the script and every static relative import or export dependency resolve inside the staged runtime.

The existing documentedSkillRuntimeRequirements behavior is replaced or extended so validateSharedRuntimeConsumers consumes requirements from the complete staged selector index, not only filesystem references reachable from an installed SKILL.md. When the staged launcher or any linked bootstrap will serve selectors, every documented script target from all indexed slices is added to the existing commands/moduleDependencyErrors validation pass.

This validation runs against the staged snapshot before publication as well as against source during npm run check. A prompt-only selector that names a missing script or a script with a missing relative dependency therefore blocks build and installation before the new runtime becomes current.

### Permissions

The workflow permission generator adds the launcher prefix agentgear skill get and its stable absolute launcher form for Claude Code, Codex, and Gemini CLI. Canonical-selector retrieval is local and read-only; the same prefix also covers requester-approved upstream retrieval, whose first use may perform the separately documented pinned fetch. Existing exact agentgear run <skill> grants remain only for skills that retain executable runtime scripts.

Removing the prototype incremental review script also removes its agentgear run review-tech-design grant. multi-agent-protocol and tech-design-workflow script grants remain because their owning scripts remain. Permission migration detection treats a missing skill get approval as an outdated workflow permission set and prints the existing reinitialization guidance.

Canonical selector retrieval performs no host I/O and needs no Waypost or session-host permission. Waypost's MCP allowlist and durable transport behavior are unchanged.

agentgear skill get agent-deck is distinct: it may perform the already declared pinned upstream fetch when no verified materialization or staged payload is available. Permission documentation must describe that network-capable path separately from read-only local canonical selector retrieval.

## Disposition of the current prototype

Retain:

- the shorter technical-design SKILL.md direction;
- the action and mode-oriented reference split where resulting slices meet selector and size rules;
- the reviewer-first canonical context dispatch wrapper and its durable delivery tests;
- host-neutral session and permission improvements independent of incremental evidence state.

Remove or supersede:

- skills/review-tech-design/scripts/prepare-incremental-review.mjs;
- tests/workflow-tech-design-incremental-review.test.mjs and its package test entry;
- reviewer Evidence Index, Review Ledger, review-state.json, per-file record-evidence behavior, and generated diff-path contracts;
- prompt wording that treats unchanged hashes or a whole-worktree fingerprint as proof that repository evidence remains valid;
- permission grants present only for the removed script.

Later-round design review may use an ordinary diff between immutable design artifacts or commits as navigation evidence. The complete current artifact remains authoritative. The reviewer reuses evidence from unchanged source and rechecks only evidence affected by the artifact diff, repository changes, or a current contradiction.

## End-to-end flows

### Manual receiver flow

1. The agent receives a delivery through the discoverable Waypost MCP or CLI.
2. An `Action: <value>` field selects route-waypost-action.
3. It retrieves `agentgear skill get action:<value>` and follows the returned instructions.
4. The alias resolves directly to the owning executable selector, or to one tiny discriminator selector for the six branching actions listed above.
5. The agent retrieves any additional addresses named by that stage, optionally batching cross-skill needs in one ordered invocation, executes them, and settles the claim.
6. The agent reuses remembered stable guidance. It repeats the exact alias or selector lookup only when it no longer remembers that guidance, the user asks, or there is evidence it changed. The environment-adaptive `browse-web` and `search-files` bootstraps are local exceptions and refresh their advisory candidates at the start of each matching task turn.

### Direct workflow start

1. The user invokes an entry such as tech-design-workflow.
2. Its bootstrap retrieves `agentgear skill get tech-design-workflow`.
3. The start slice selects draft-review or review-existing and names the next exact selector.
4. Session-host or tool-resolution selectors are retrieved only if collaborator lifecycle work is needed.

### Explicit compatibility skill

1. A user installs agentgear install --skill review-code.
2. The otherwise prompt-only review-code directory is exposed to the target.
3. Its small SKILL.md retrieves agentgear skill get review-code start. Detailed content still comes from the canonical runtime.
4. A later authoritative pack install may remove this managed exposure unless review-code is repeated with --skill; this is accepted hard-cut behavior.

### Legacy full-pack uninstall

1. Begin with schema-v2 state from the preceding release containing every workflow skill link.
2. Upgrade Agentgear without first reconciling installation state.
3. Run agentgear uninstall --pack workflow.
4. The uninstaller uses workflow capabilitySkills and removes every matching owned recorded link, including skills now marked prompt-only.
5. No obsolete prompt-only discovery directories remain.

## Failure behavior

- Missing or corrupt selector content fails before workflow execution with an exact skill/selector or alias diagnostic. The agent does not guess.
- A message without an Action field is handled as an ordinary personal message.
- An unsupported action is not guessed or rejected by the router; the Receiver Contract fails any associated claim as a routing failure.
- A prompt-only skill explicitly exposed without a working launcher produces an actionable bootstrap error; --no-launcher warns during installation.
- A failed authoritative update rolls back owned withdrawals, new writes, runtime publication, and installation state.
- A recorded path that no longer matches its ownership record blocks ordinary withdrawal and is preserved. Only the separately invoked legacy migration may remove an exact whitelisted immediate child by name.
- Duplicate selector or alias metadata fails validation, build, and runtime lookup. Scan order is never semantic.
- Invalid runtime-command declarations or appendices fail validation, build, and runtime lookup. Missing optional commands, denied probes, or a missing CodeGraph index simply omit the affected advisory appendix.
- A missing or dependency-broken script named only by a prompt-only selector fails staged-runtime validation.
- agentgear skill get agent-deck never returns unverified upstream content; an unavailable network with no valid materialization or staged copy fails without changing targets, published runtimes, or installation state. A successful first retrieval may create only the verified retrieved-skills materialization.
- A corrupt or locally changed retrieved-skill materialization blocks reuse, is preserved by full purge, and makes that purge exit 1 after unrelated verified owned artifacts are removed; target-limited purge does not inspect it.

## Compatibility

Codex, Claude Code, Gemini CLI, OpenCode, Antigravity, and Kiro continue to discover their existing skill directory formats. The discovery change is the smaller exact entry set after default or pack installation. Skill selector output is plain Markdown and harness-neutral.

Claude ordinary repeated Skill calls are not presented as faulty or repeatedly reinjecting full skill bodies. Compaction recovery may reload active material, and smaller bootstraps reduce that recovery payload without changing Claude-specific semantics.

All current catalog skill names are canonical, listable through agentgear list, and explicitly installable with --skill. Their detailed instructions are independently addressable, with action aliases globally available as bare unique addresses. Internal protocol selectors such as `multi-agent-protocol/internal/dispatch-plan` are addressable only through their owning canonical skill and are not independently installable. The upstream agent-deck name is listed as an upstream retrievable skill and uses skill get rather than --skill installation. The 17 accepted canonical entries remain installed by default.

The existing workflow-level `message_rejected` action remains registered independently of the received-Action router. Agentgear-owned message envelopes drop body `From`/`To` routing fields in favor of Waypost delivery metadata; the action-alias set makes routing explicit and rejects unsupported retired tokens.

Third-party tools may read dist/universal/skills as canonical source input, but must not install it as a runnable skill collection. Executable consumers use the same-release npm package or normal installer. Target-specific layouts intentionally represent only the minimal entry surface and are likewise not standalone without the matching launcher/runtime.

Users who need the host documentation explicitly run agentgear skill get agent-deck; doing so returns its content without adding another discoverable skill.

Canonical selector lookup does not change installation state, creates no files, and stores no cache. Upstream no-selector retrieval may create only the verified retrieved-skills materialization. Authoritative pack reconciliation may remove an older explicitly installed prompt-only managed skill; this is deliberate requester-approved compatibility behavior.

## Tests and acceptance gates

Add or update tests for:

1. selector frontmatter parsing, contained traversal, symlink rejection, deterministic selector listing, exact canonical and alias lookup, frontmatter removal, trailing-newline normalization, text output, and status 1 versus status 2 failures;
2. agentgear skill get/list from a source checkout, staged physical release, shared current launcher, and copy-fallback wrapper, including skill-name entry lookup, one-address plain output, repeated and cross-skill caller order, exact `agentgear skill: <address>` labels, two-space body indentation, one empty line between blocks, and atomic unknown/ambiguous-address failure with empty stdout;
3. agentgear skill get agent-deck from an existing verified materialization, a verified immutable-runtime copy, and a fresh pinned fetch, including the complete multi-file tree, required Base directory for this skill preamble, atomic concurrent creation, offline reuse, digest/manifest corruption, unknown sub-address status 2, no mutation of published runtimes, no target write, and no installation-state exposure record;
4. catalog exposure validation, global alias uniqueness, list --json reporting, and the exact 17-entry set with no implicit upstream host skill;
5. the complete current action-alias set, with every exact message-template Action covered and every alias target present; include all current design, review, browser, plan, delegation, advisory, group, and result actions rather than representative samples;
6. received Action routing: discovery identifies an `Action: <value>` field, the router retrieves `action:<value>`, and the prompt contains no duplicate parser or token-validation contract;
7. direct one-lookup routing for one-to-one actions and small discriminator routing only for browser_check_report, design_spec_review_requested, group_message_available, rework_required, work_accepted, and abort_iteration;
8. implicit/default all installation exposing exactly the 17 accepted canonical entry names on every target, and each explicit pack exposing exactly the entry subset in its resolved closure: core exposes its eight entries, workflow exposes its nine entries, browser exposes the same nine through workflow inclusion, and explicit pack unions plus --skill expose the corresponding union; agent-deck is never implicit in any case;
9. explicit installation of a prompt-only canonical skill, mixed pack-plus-skill retention for that invocation, explicit-skill-only additive behavior, and later authoritative pack withdrawal;
10. schema-v2 pre-change full-pack fixtures proving install/update reconciliation and uninstall --pack workflow/browser/all remove recorded, ownership-matching legacy prompt-only and historical agent-deck links;
11. ownership safety for missing destinations, matching links, matching copies, mismatched links, unmanaged directories, and --force not widening withdrawal;
12. transactional rollback after an owned withdrawal when a later target write, launcher publication, or state save fails;
13. build output, which represents the implicit all selection, containing all canonical skills under dist/universal as source material and exactly the 17 accepted entries under every target layout, with no upstream agent-deck directory and a generated universal warning that rejects copy-as-install usage;
14. retrieved-skills lifecycle: exact content-addressed layout and manifest, immutable validated reuse, no harness discovery path overlap, retrieval-only/state-null full purge, full purge with installed targets, target-limited purge retaining global materializations, current-catalog ownership proof, preservation of older or unknown pins, unchanged owned removal, changed/corrupt preservation with status 1 but no block on unrelated owned deletion, symlinked parent and unexpected-shape rejection, quarantine rollback on removal failure, and no effect from ordinary install, update, source-install, or non-purge uninstall;
15. entry and slice byte limits, referenced skill/selector pairs, and safe fully qualified alias grammar;
16. staged runtime validation of scripts referenced from entry and prompt-only slices, including failing missing-script and missing-relative-dependency fixtures;
17. Claude, Codex, and Gemini permission output containing agentgear skill get, retaining required script grants, and dropping the removed incremental-review grant;
18. doctor/readiness behavior with current, outdated, and invalid-output Waypost executables; Agent Deck only, Thurbox only, neither host, verified retrieved documentation, verified immutable-runtime documentation, no local documentation, and corrupt local documentation; assert that optional documentation never changes an otherwise valid readiness result, doctor performs no network fetch or MCP probe, and no output checks, recommends, or creates a target `agent-deck/SKILL.md`;
19. the one-time migration command's exact checked-in whitelist, refusal on valid or invalid installation state, state-absent apply recheck, no mutation of runtime/launcher/retrieval/permissions, default global roots including Kiro, explicit target/project/destination resolution, root-symlink rejection, immediate-child and basename containment, removal of whitelisted file/directory/symlink entries without traversal, preservation and non-enumeration of non-whitelisted children, full-scope preflight, dry-run/apply output, quarantine rollback, zero-candidate and repeated-run idempotency, rejected options, and proof that ordinary install/update/uninstall/purge cannot call name-only deletion;
20. retained technical-design context-first dispatch and removal of incremental evidence-state expectations.

Before delivery or release, run npm run check. It must validate sources, regenerate dist, and pass the complete test suite. dist must not be hand-edited.

## Rollout and rollback

Ship this as one release because small bootstraps depend on the skill content command, action aliases, and exposure semantics.

Implementation order:

1. Add the skill selector index, skill get/list CLI, explicit upstream materialization, indexed aliases, and source/staged validation while current skills still work.
2. Add exposure metadata and split capabilitySkills from exposedSkills.
3. Split and annotate canonical selector slices, starting with receiver safety and the complete action-alias set, then shared protocol and workflow stages, then standalone entries.
4. Add hard-cut target reconciliation and capability-based recorded legacy uninstall tests.
5. Add the isolated one-time legacy migration command, fixed whitelist, dry-run/apply safety checks, and operator documentation.
6. Switch build layouts and permissions, add the universal source-only notice, update installation documentation, and add restart notices.
7. Remove the incremental evidence prototype.
8. Run npm run check and inspect generated target layouts before publishing.

Release notes and installer output state that default or pack operations authoritatively withdraw recorded Agentgear-managed skill directories not selected by the current configuration, including ownership-matching historical automatically exposed agent-deck links; that state-lost historical discovery entries require the separately documented one-time migration command; that explicit-skill-only canonical operations remain additive; that dist/universal/skills is source material rather than an installation; and that existing sessions should restart.

Rollback is a normal install or source-install of the preceding pinned revision. Schema-v2 state remains readable. The preceding installer stages its own snapshot and can expose its historical full selection again. A mismatched or unmanaged path remains untouched in either direction. No Waypost data, workflow history, or user repository data is migrated or deleted.

## Alternatives rejected

Moving large SKILL.md bodies into ordinary references without a lookup API is insufficient because Codex provides no cache guarantee and recovery still depends on installation-specific paths.

Treating Claude's post-compaction restoration as a defect is rejected. It is reasonable recovery behavior; the redesign is justified by minimal exposure, Codex repeated context pressure, smaller recovery payloads, and a common explicit lookup path.

Installing a generated monolithic router skill is rejected because it recreates a large repeatedly loaded prompt. Distributed aliases resolve one-to-one actions directly to their owning slices without a second source of routing truth.

Mapping every action through a receiver-owned routing selector is rejected because it adds a needless second skill get. Only actions with a real message discriminator use a small routing selector.

Automatically exposing the pinned upstream agent-deck skill is rejected because it creates an eighteenth default entry, adds roughly 61 KiB of prompt text, and makes host availability silently change the public skill surface. Internal verified staging is sufficient for existing runtime reuse needs.

Removing all access to the upstream skill is also rejected. Explicit agentgear skill get agent-deck preserves on-demand documentation access without installing it or making every harness session discover it.

Adding a workflow interpreter or state machine is rejected because the requested behavior is document disclosure. The agent and existing workflow messages remain the execution engine and state context.

Moving Agentgear routes into waypost doc is rejected because it crosses the transport/workflow ownership boundary.

Generating a persistent selector index or cache is rejected because it creates invalidation and migration work. Restricted frontmatter plus per-invocation indexing is sufficient at repository scale.

Treating dist/universal/skills as a runnable full-tree installation is rejected because its bootstraps depend on the same-release launcher. Keeping it explicitly source-only avoids a split-version support contract without duplicating a launcher bundle inside dist.

Adding installation provenance solely to distinguish historical explicit prompt-only selections is rejected by requester decision. Authoritative current pack selection is simpler and acceptable for the sole current user.

Using a long-lived historical upstream pin or digest catalog solely to delete legacy paths is rejected. The one-time migration command uses the requester-approved fixed name whitelist only within its bounded target roots, while ordinary commands retain evidence-based ownership.

Keeping the prototype's incremental evidence cache is rejected because it adds state and per-file bookkeeping unrelated to prompt disclosure and cannot prove that unrecorded repository context remains unchanged.
