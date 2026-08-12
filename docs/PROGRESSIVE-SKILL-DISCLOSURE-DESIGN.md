# Progressive Skill Disclosure for Agentgear

## Status and goal

This design changes Agentgear from exposing the complete maintained skill collection to every harness into exposing a small public entry set while keeping the complete canonical collection in the managed Agentgear runtime. Detailed instructions are retrieved as small Markdown prompt slices through the existing agentgear launcher.

The design preserves these ownership boundaries:

- skills/<name>/ remains the only hand-authored source of agent-facing instructions and runtime scripts.
- Agentgear owns workflow routing, workflow-stage instructions, and closeout policy.
- Waypost remains the durable message transport and does not acquire Agentgear workflow documentation or routing behavior.
- The agent interprets and executes retrieved text. The CLI only indexes and returns documents; it does not execute a workflow, advance state, parse Waypost message bodies, or decide outcomes.

Success means a normal installation exposes exactly the accepted fourteen public entry skills, a manually invoked check-waypost-messages remains available and small, an inbound Action selects the first executable owning slice with one lookup unless a real discriminator is required, and any slice can be listed and fetched again through agentgear skill without knowing an installation path.

## Accepted requester decisions

The following product choices are authoritative for this design:

- The default installed and discoverable entry set is exactly fourteen skills: assess-tech-design, check-waypost-messages, code-health-review, commit-staged, delegate-task, dispatch-plan, explain-for-me, explore-defects, fix-strategy, handoff, refactor-review, roundtable, simplify-review, and tech-design-workflow.
- The entry set remains declarative in catalog metadata so later adjustment is a catalog edit rather than an installer rewrite.
- Agentgear-managed skill links that are outside the effective pack and explicit-skill selection are removed by authoritative pack/default install, link, or update reconciliation.
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

Every maintained skill directory remains present under skills/<name>/, with its existing scripts, agents metadata, assets, and other owned material. Agent-facing content is divided into two forms:

1. SKILL.md is a concise bootstrap for direct or compatibility installation. It contains only enough instruction to identify the first selector, invoke agentgear skill get, and recover after compaction. Every SKILL.md, including a prompt-only skill installed explicitly, remains independently valid.
2. Markdown files below skills/<name>/references/ hold the detailed prompt slices. Existing reference directories are reused; no parallel prompt source tree is introduced.

A prompt slice opts into the runtime index with restricted frontmatter:

~~~markdown
---
skill-selector: author-round
selector-summary: Draft or revise one immutable design round and request review.
selector-aliases: check-waypost-messages/action:design_spec_draft_requested, check-waypost-messages/action:design_spec_context_corrected
---

# Author Round
...
~~~

Rules for this metadata:

- skill-selector is the stable selector local to the owning skill. It uses lowercase letters, digits, dots, underscores, hyphens, and slash.
- The canonical address is the pair <owning-skill>, <skill-selector>; for example agentgear skill get tech-design-workflow author-round.
- selector-summary is one non-empty line used by listing and diagnostics.
- selector-aliases is optional and contains comma-separated, fully qualified <lookup-skill>/<selector> addresses. Selector portions use letters, digits, dot, underscore, hyphen, slash, and colon, contain no whitespace, and are at most 256 bytes.
- Canonical addresses and alias addresses are globally unique. Validation and runtime lookup fail on duplicates, alias/canonical collisions, or scan-order ambiguity.
- File location below references/ is not an API. A file may move within its owning skill without changing its selector.
- Prompt bodies refer to other prompt content with exact skill and selector arguments, for example agentgear skill get multi-agent-protocol session-host, never by an installation-specific path.
- Prompt bodies may refer to runtime scripts only through the existing agentgear run <skill> <script> form.
- The skill command removes the metadata frontmatter and returns only the Markdown body in normal single-selector text mode.

An alias is declared on the prompt slice it resolves to; no central action-to-file manifest is introduced. The lookup-skill portion may differ from the content owner. This lets an owning workflow slice declare check-waypost-messages/action:<token> and resolve the receiver's one lookup directly to that body. action: has no special CLI execution semantics.

Every Agentgear-owned canonical skills/<name>/SKILL.md must be at most 2 KiB. Each indexed prompt slice must be at most 8 KiB. Limits are byte-based and deterministic. Large current canonical skills are split by stable action or execution stage until they meet the slice limit. These limits do not apply to the separately retrieved upstream agent-deck payload; they apply only to Agentgear-owned canonical agent-facing text, not scripts or maintainer documentation.

### Skill content CLI

Add one skill-centric retrieval namespace to the existing launcher:

~~~text
agentgear skill get SKILL [SELECTOR...] [--json]
agentgear skill list SKILL [--json]
~~~

There is no agentgear prompt command.

The public positional shape is `agentgear skill get <skill> [selector...]`. Options may appear before the skill name for conventional parsing, and `--` may appear before `SKILL` when the first positional value could be parsed as an option.

For an Agentgear-owned skill, get with no selector returns that skill's SKILL.md body with metadata frontmatter removed and one trailing newline. This is the overview/bootstrap recovery path. With selectors, the command resolves every requested selector under the named lookup-skill namespace. A selector first matches a canonical selector owned by that skill, otherwise an exact fully qualified alias <SKILL>/<SELECTOR>, which may resolve to a slice owned by another skill.

Text formatting mirrors the installed Waypost doc contract:

- no selector: write the overview/bootstrap body with no label;
- one selector: write its plain prompt body with no label;
- two or more selectors: preserve argument order and repetitions; for each requested selector write agentgear skill: <SKILL>/<SELECTOR>, then every body line indented by two spaces; separate blocks with exactly one empty line and end the combined output with one newline;
- resolve and read all selectors before writing stdout; any unknown selector fails atomically with no partial stdout.

The exact multi-selector label is agentgear skill: <SKILL>/<REQUESTED_SELECTOR>. It names what the caller requested, even when that address is an alias whose canonical content owner differs. This is the Agentgear adaptation of Waypost's waypost: <topic> label.

Frontmatter is never included in a returned prompt body. Each body otherwise remains unchanged except for normalizing to one trailing newline. The multiple-selector formatter trims that final newline before indenting, including blank lines as two-space lines.

skill list is the separate deterministic selector-discovery operation. Text mode writes every selector addressable under the named skill, one per line in bytewise order, including aliases such as action:<token>. It accepts no query, returns an empty success for a skill with no selectors, and performs no fuzzy matching. JSON mode returns ordered records with requested skill, selector, canonical owner, canonical selector, aliases, and summary.

get --json returns one JSON document only after every request resolves. It contains skill, overview when no selector was supplied, and otherwise an ordered selections array whose records contain requestedSelector, owner, selector, aliases, summary, body, and optional resourceBase. Repeated arguments produce repeated records. JSON mode does not use text block labels.

Unknown skills or selectors exit status 2 with a concise diagnostic and skill list recovery guidance; corrupt or duplicate runtime metadata exits status 1. Neither operation accepts a filesystem path, glob, URL, Waypost body, workflow state, or execution arguments. -- ends option parsing before SKILL so selector values beginning with punctuation remain argv data.

The selector index is built in memory for each command invocation by scanning skills/*/references/**/*.md below the runtime root containing the CLI. Traversal is contained, symlink-free, and deterministic. There is no generated index and no persistent cache. Source checkouts, staged physical releases, shared current launchers, and copy-fallback wrappers therefore use the same content model.

The command remains generic. It knows skills, selectors, aliases, and bodies. It does not parse message bodies, branch on roles or workflow modes, expand dependencies, call Waypost, create sessions, or interpret an action. It returns only the explicitly requested overview or selectors.

### Complete action contract and direct routing

The set of indexed selector-aliases whose lookup address begins with check-waypost-messages/action: is the sole declaration of supported inbound Waypost actions. A token is supported only when exactly one indexed slice owns that alias. This replaces the open-ended phrase every supported inbound action with an enforceable distributed registry.

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
| design_spec_context_corrected | tech-design-workflow/author-round | Direct author execution. |
| design_spec_decision_requested | tech-design-workflow/requester-decision | Direct requester handling. |
| design_spec_delivered | tech-design-workflow/requester-delivery | Direct requester closeout. |
| design_spec_draft_requested | tech-design-workflow/author-round | Direct author execution. |
| design_spec_review_context | review-tech-design/context-intake | Direct reviewer context intake. |
| design_spec_review_context_recovery_requested | tech-design-workflow/context-recovery-route | Branches on actual recipient and Relay. |
| design_spec_review_context_rejected | tech-design-workflow/requester-context-correction | Direct requester handling. |
| design_spec_review_report | tech-design-workflow/report-handling | Direct author or review-existing requester handling. |
| design_spec_review_requested | review-tech-design/review-request-route | Branches on draft-round versus committed-docs Mode. |
| execute_delegate_task | delegate-code-task/execute | Direct coder execution. |
| execute_delegated_task | delegate-task/execute | Direct non-code worker execution. |
| execute_plan | execute-plan/start | Direct planner execution. |
| group_message_available | check-waypost-messages/group-route | Branches on Group-Address and As-Person; roundtable is one branch. |
| plan_report_delivered | plan-report/receive | Direct supervisor handling. |
| refactor_review_report | refactor-review/report-received | Direct result delivery. |
| refactor_review_requested | refactor-review/review | Direct execution. |
| review_requested | review-code/review | Direct review execution. |
| review_task_context | review-code/task-context | Direct context intake. |
| rework_required | review-code/result-route | Branches on task, integration-final, standalone, and matching plan context. |
| roundtable_participant_turn | roundtable-participant/turn | Direct participant execution. |
| simplify_review_report | simplify-review/report-received | Direct result delivery. |
| simplify_review_requested | simplify-review/review | Direct execution. |
| stop_recommended | review-code/result-route | Branches on acceptance lane and closeout owner. |
| user_requested_iteration | delegate-code-task/user-iteration | Direct coder continuation. |

The action set deliberately excludes retired review_completed and other unsupported legacy actions. Adding, renaming, or removing an action requires changing the owning slice's selector-aliases metadata and any producer template in the same change.

Validation collects every exact Action: <token> line in indexed selector bodies and skill-owned JavaScript message templates. Every collected token must appear in the action-alias set. Dynamic, placeholder, duplicate-choice, or shell-expanded Action values in an executable message template are invalid; conditional outputs use separate exact templates. Generic protocol prose must describe the header without an Action: placeholder line. Transport-originated actions such as group_message_available may be registered without a local producer. Tests assert the full discovered set against the aliases, not a representative subset.

This validation is static documentation and template consistency checking. The CLI still does not interpret or emit workflow messages, and no central routing manifest duplicates the owning slice metadata.

### Safe receiver parsing and invocation

check-waypost-messages/SKILL.md remains directly installed and fits within the 2 KiB bootstrap budget. Its bootstrap is limited to:

1. Call waypost_status first only when the active Waypost tool contract requires it.
2. Call waypost_recv to claim one personal delivery.
3. If no delivery is returned, report that and stop.
4. Parse and validate exactly one Action header from the received body.
5. Invoke agentgear skill get -- check-waypost-messages action:<validated-token> as separate argv elements and follow the returned selector body.
6. Use fixed invalid-envelope or unknown-action selectors on failure.
7. Before ending, settle every claim owned by the session.

The Action parser contract is exact:

- Normalize CRLF to LF for parsing only.
- The envelope header block is the consecutive non-empty lines from the first byte of the body through the first empty line.
- Treat header names case-insensitively for duplicate detection, but require the single accepted spelling Action.
- Require exactly one header line matching Action: <token>. Missing, repeated, case-variant, or malformed Action headers are invalid.
- The token must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}. Do not trim arbitrary payload into validity.
- Never pass the raw body or raw header line to a shell or to skill lookup.
- Construct the lookup key only after validation by prefixing the token with the constant action:.
- Invoke the launcher through a structured argv-capable tool. When only a shell tool is available, use a fixed command template plus a grammar-validated token as one quoted argument after --; eval, command substitution, pipes, redirection, and concatenating an unvalidated string are forbidden.

Malformed envelopes retrieve agentgear skill get check-waypost-messages invalid-envelope. A syntactically valid but unregistered action produces status 2 and retrieves agentgear skill get check-waypost-messages unknown-action. Both selectors instruct the agent to report the problem and call waypost_fail for the claim when available; otherwise release it and report the transport limitation. Neither path acknowledges the delivery or guesses another workflow.

### Small installed entries

Add a required exposure field to every canonical skill record:

~~~json
"check-waypost-messages": {
  "tags": ["workflow", "receiver"],
  "exposure": "entry"
}
~~~

Allowed values are:

- entry: included in harness discovery when a containing pack is selected.
- prompt-only: retained in the canonical runtime and selector index, but not exposed by pack selection.

The exact accepted entry set is:

- assess-tech-design
- check-waypost-messages
- code-health-review
- commit-staged
- delegate-task
- dispatch-plan
- explain-for-me
- explore-defects
- fix-strategy
- handoff
- refactor-review
- roundtable
- simplify-review
- tech-design-workflow

The remaining current canonical skills are prompt-only: browser-test, browser-test-request, delegate-code-task, execute-plan, multi-agent-protocol, plan-report, planner-closeout, refactor-review-request, review-closeout, review-code, review-request, review-tech-design, and roundtable-participant.

The choice preserves the directly useful advisory reviews while keeping request helpers, persistent worker handlers, and receiver-selected workflow stages out of default discovery. It exists only in per-skill exposure metadata; there is no second entry-name array in implementation code. The list above is the accepted product contract and its test expectation.

The pinned upstream Agent Deck skill is not a public entry and is never copied or linked into a harness discovery target by default or pack selection. Its current approximately 61 KiB SKILL.md would violate both the exact fourteen-name product decision and the minimal-disclosure goal.

The upstream payload may still be provisioned while staging a new immutable managed runtime when selected session-host requirements need it. Internal staging does not create a target skill record and does not make the upstream skill discoverable. Existing Agentgear-managed target records for agent-deck are outside the new desired exposure set and are withdrawn by the same authoritative reconciliation and ownership guards as other obsolete managed links.

The same skill get namespace handles the catalog-declared upstream agent-deck skill. It has no indexed selectors in this release; get with no selector returns the upstream overview plus a usable resource base, while skill list agent-deck returns an empty list.

For agent-deck:

- skill get accepts the catalog-declared upstream name with no selector; any selector is unknown and fails status 2.
- It materializes the complete verified upstream skill tree in a content-addressed, non-discovery resource store at <data-root>/retrieved-skills/agent-deck/<digest-hex>/payload. This path is outside every harness target and every runtime release.
- A sibling manifest records schema version, upstream name, repository, ref, commit, content digest, and payload-relative SKILL.md. The digest-hex path component is the 64-character suffix of the catalog contentDigest and is safe on every supported platform.
- On each get, validate an existing materialization's manifest and complete tree digest. If absent, first reuse an already staged copy from a current or retained immutable runtime only when that runtime's catalog pin matches and the payload passes digest verification. Otherwise perform the existing sparse pinned fetch in a temporary checkout.
- Copy the complete verified tree into a same-parent temporary materialization, verify it again, write the manifest, and atomically rename it into the final content-addressed path. Never write into a published immutable runtime. If a concurrent creator wins the rename, accept its result only after revalidation.
- Text mode follows the no-selector overview rule but prepends the minimum launcher-controlled resource context required by this multi-file upstream skill: Base directory for this skill: <absolute payload path>. It then writes the exact upstream SKILL.md body with one trailing newline. This is not a generic selector wrapper; it supplies the same base-directory fact the upstream instructions require for relative references and scripts.
- JSON mode returns skill, overview, and resourceBase plus repository, ref, commit, and contentDigest. resourceBase is a deliberate public filesystem address because the retrieved multi-file skill requires it.
- It does not copy or link the skill into any harness target, add an installation-state target record, alter exposure selection, or index third-party resources as canonical selectors.
- Unknown or non-upstream skill names exit status 2. Fetch, digest, or runtime corruption fails status 1.
- Because first materialization may require the network, it uses the existing upstream-fetch trust and permission boundary. A verified materialization is durable and offline-retrievable.
- If the final content-addressed path or manifest exists but fails validation, do not overwrite or delete it automatically. Fail with the exact path and remediation guidance.

The retrieved-skills root is Agentgear-owned persisted data, not prompt cache or installation state. It has a self-authenticating ownership contract independent of schema-v2 installation state: each purge candidate must be exactly `<data-root>/retrieved-skills/<catalog-upstream-name>/<64-lowercase-hex-digest>`, be a real directory reached without symlinks, and contain the Agentgear retrieval manifest whose upstream name, repository, ref, commit, contentDigest, payload-relative SKILL.md, and complete payload digest match the current catalog upstream declaration and the digest-named directory. Directory names, a SKILL.md file, or marker-shaped data alone never establish ordinary purge ownership. Discovery scans only direct upstream-name and digest children under this fixed root, rejects symlinks and deeper or unexpected shapes, and never follows a manifest-supplied path outside the candidate. A materialization from an older pin that the current catalog cannot verify is preserved and reported; ordinary purge does not acquire a historical pin catalog or use name-only authority to remove it.

`agentgear uninstall --purge` applies these exact modes:

- A full purge is an invocation without `--target`, `--dest`, or project-scoped target selection. It preflights every schema-v2 target/runtime candidate when state exists and every discovered retrieved-skill candidate whether state exists or not. A retrieval-only installation with no state is therefore not an early no-op: unchanged verified materializations are removed, empty retrieved-skills directories are pruned, and success is reported. If neither state-owned artifacts nor retrieved candidates exist, the existing no-state no-op message remains appropriate. If state is null but managed runtime markers or `current` exist, preserve the existing coherence failure and do not use retrieved-skill cleanup to legitimize or remove that ambiguous runtime data.
- A target-limited purge removes only the selected target records and their verified owned links or copies. It never removes or preflights global retrieved-skills data, even when the selected target is the last managed target and normal runtime teardown consequently occurs. The materialization remains available because retrieval ownership is global rather than target-scoped; removing it requires a later full purge.
- For a full purge, a verified unchanged materialization is added to the removal plan. A candidate with a missing, corrupt, historically unknown, or ownership-mismatched manifest, a mismatched payload digest, a symlink, or unexpected contents is preserved and reported with its exact path as `preserved unverifiable retrieved skill`; it is never overwritten or deleted by `--force`.

Purge uses two independent ownership domains. Existing target/runtime ambiguity keeps its current fail-before-mutation behavior so external target links and the shared runtime are not partially deleted. Retrieved-skill ambiguity does not block unrelated verified target/runtime deletion: changed or corrupt materializations are preserved and reported while other owned artifacts are removed. After all planned removals, any preserved retrieved candidate makes the full command finish with status 1 and `Purge incomplete: retrieved skill materialization requires manual cleanup`; otherwise it finishes with status 0. Removal of verified retrieved materializations occurs only after target/runtime preflight succeeds and the existing target/runtime mutation and state save or state removal have completed. Each retrieved candidate uses a same-parent quarantine rename before recursive deletion. If that deletion fails, restore the quarantine entry to its original path when possible, report the exact residual path, and exit 1. This ordering keeps schema-v2 state consistent with completed target/runtime removals and gives retrieved resources per-candidate rollback; the design adds no persistent transaction log or promise of cross-domain rollback after target/runtime teardown has succeeded.

Ordinary install, update, link, pack uninstall, skill uninstall, and target-limited purge do not remove retrieved materializations, so explicit retrieval remains usable until a successful full purge.

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

- With no --pack or --skill, all is selected as today, and exactly the fourteen accepted canonical entries are exposed.
- --pack NAME exposes entry members of that pack closure.
- --skill NAME explicitly exposes that named skill even when it is prompt-only.
- --pack NAME --skill NAME exposes the pack entries plus the explicit skill.
- An explicit-skill-only install remains additive.
- A default or explicit-pack install, link, or update is authoritative for the selected targets and reconciles them to selectedInstallableSkills.

Pack descriptions change so all means all maintained capabilities, not every skill directory exposed to a harness. The workflow and browser external command and alternative session-host requirements remain unchanged, but upstream documentation is no longer a target-installation readiness requirement. `agentgear list --json` reports each skill's exposure; selector discovery belongs to `agentgear skill list` rather than treating aliases as skills.

Catalog schemaVersion remains 1 because exposure is an internal additive field consumed atomically by this release. The updated validator requires a valid exposure for every canonical skill. Selector aliases stay with canonical agent-facing slices rather than becoming catalog product metadata.

### Doctor and readiness

`agentgear doctor` separates executable readiness from optional upstream documentation availability:

- Required pack commands retain their existing `ok` or `missing` checks and affect exit status.
- Each alternative session host prints only its external executable state, for example `ok      session host agent-deck (agent-deck)` or `unavailable session host agent-deck (agent-deck)`. At least one declared host must be available for workflow and browser readiness, exactly as today.
- A host's catalog `upstream` field describes optional documentation for explicit skill retrieval; it no longer causes a lookup under any harness target and is not counted in the missing-requirement total. The separate `requirements.upstreams` loop is removed for this catalog because packs do not require an installed upstream skill.
- For Agent Deck, doctor validates documentation without network access. It searches the current verified catalog digest first in `<data-root>/retrieved-skills/agent-deck/<digest-hex>/payload`, then in the current or retained immutable runtimes whose embedded catalog pin matches. It prints exactly one informational state: `ok      optional documentation agent-deck (verified local resource)`, `available optional documentation agent-deck (run: agentgear skill get agent-deck)`, or `warning optional documentation agent-deck (unverifiable local resource: <path>)`. `available` means no verified local copy is present and never triggers a fetch. `warning` reports corruption but does not make an otherwise ready host fail; explicit `skill get` and full purge retain their stricter validation behavior.
- Doctor never prints `missing` or `provision` for `<target>/agent-deck/SKILL.md`, never recommends installing or linking agent-deck into a harness, and never counts optional documentation toward readiness. With Agent Deck on PATH and no local payload, workflow doctor succeeds and reports the explicit retrieval command. With only Thurbox available, workflow doctor succeeds without requiring Agent Deck documentation.

The catalog continues to declare the pinned upstream under the Agent Deck session host so staging and explicit retrieval can share one trust anchor. Documentation status is derived from that host declaration rather than adding a second pack requirement or a fifteenth skill exposure.

### Hard-cut installation reconciliation

Installation state remains schema version 2. No provenance field or automatic state migration is added.

For install, link, or update on selected targets:

- If the invocation selects any pack, including the implicit default all, compute desired managed skill names as selectedInstallableSkills.
- Compare every recorded Agentgear-managed skill on each selected target with that desired set.
- A recorded active skill outside the desired set is withdrawn, whether it was historically installed by a pack or by an explicit --skill. This current-invocation authority is intentional and requester-approved.
- An explicit-skill-only invocation does not run withdrawal reconciliation and remains additive.

Withdrawal preflight uses existing ownership records:

- If the destination is absent, remove the stale state record.
- If a linked destination exactly resolves to the source recorded in schema-v2 state, remove the link transactionally and remove its record. The record may point at the managed current runtime path whose target changes during publication; ownership is the exact recorded link target, not a content comparison.
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

The installer prints every withdrawn name and a final notice to restart existing agent sessions so discovery and permission state reload. No active skill is added to retiredSkills because prompt-only names remain canonical and explicitly installable.

--no-launcher remains supported only for users who already provide a compatible agentgear command. Help and completion output state that every bootstrap entry requires agentgear skill get. The installer warns when --no-launcher is combined with exposed Agentgear entries and does not attempt to adopt an unrelated launcher.

### One-time legacy skill migration

Add one exceptional public subcommand:

~~~text
agentgear migrate legacy-skills [--target NAME[,NAME] | --dest DIR] [--scope global|project] [--project DIR] [--apply]
~~~

This command exists only for the sole current user to clean pre-state or state-lost Agentgear discovery entries once on each machine, before installing the new release. It is deliberately not part of install, link, update, uninstall, purge, or retrieval. It accepts no `--pack`, `--skill`, `--force`, or arbitrary skill-name argument. Without `--apply` it is a read-only dry run. Its dedicated help and the first output line say `EXCEPTIONAL ONE-TIME MIGRATION: name whitelist is deletion authority`; the top-level command list labels `migrate legacy-skills` as an exceptional one-time cleanup and does not suggest it as routine maintenance.

Before resolving roots, the command reads and validates the normal installation state. It proceeds only when the state file is absent. A valid non-null schema-v2 state exits 1 without scanning or mutation and says `Legacy skill migration refused: recorded Agentgear installation exists; use install/update/uninstall ownership reconciliation.` A malformed, unsupported, or unreadable state also exits 1 without scanning or mutation and reports the existing state path and validation error. The migration never edits or removes state, the launcher, commands, managed runtimes, retrieved-skills, or permission files. This precondition prevents name-only cleanup from deleting a current entry while leaving its ownership record behind; state-lost runtime ambiguity remains a separate manual recovery concern.

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

This is the 27 current canonical names, the formerly exposed upstream `agent-deck`, and the eight current `catalog/skills.json` retired names. Validation requires every entry to match the safe skill-name grammar, remain bytewise sorted and unique, and equal a checked-in test fixture. Adding a name is a security-sensitive code change; catalog additions do not silently widen this command.

Target resolution is bounded and explicit:

- With no target options, inspect only the catalog's three global harness roots: `~/.agents/skills`, `~/.claude/skills`, and `~/.kiro/skills`. Unlike install defaults, the migration includes Kiro because this is machine cleanup of every supported historical global target. Default roots are resolved from the current environment and catalog; the whitelist remains code-fixed.
- `--target` selects only catalog-declared target names through the existing resolver. `--scope project --project DIR` resolves only those catalog-declared project-relative roots below the resolved project directory.
- `--dest DIR` is allowed only with the general target semantics, exactly one explicit destination, and an absolute normalized root. It cannot be combined with `--target` or project scope.
- Duplicate roots after normalization are inspected once. The command never reads schema-v2 target records to discover additional roots, never scans a home or project recursively, and never follows target-root symlinks. A missing target root is an empty success for that root.

For each selected real-directory root, read only its immediate children. A candidate is eligible only when its basename exactly equals one whitelist member, `path.dirname(path.resolve(root, basename))` equals the resolved root, and `lstat` of the candidate itself succeeds. Dot entries, nested paths, separators, case variants, Unicode lookalikes, and non-whitelisted names are outside authority. The command does not inspect a candidate's contents to infer ownership. A whitelisted immediate child may be a symlink, regular file, or directory; the migration removes the child entry itself without following it. The selected target root must be a real directory and not a symlink; an unsafe or unreadable root is an error and nothing is deleted anywhere in that invocation. On Windows, junctions and other reparse-point children are treated as link entries and unlinked without traversal; roots that are reparse points are rejected.

Execution is preflight-then-apply across the full selected scope. Dry-run prints deterministic bytewise-sorted records as `would remove legacy skill: <absolute path>` and ends with `Legacy skill migration dry run: <N> candidate(s); rerun with --apply.` Non-whitelisted children are never enumerated in normal output and remain untouched. Apply rechecks that installation state is still absent, then completes the same containment and `lstat` preflight for every root and candidate; any state or root-level error aborts with status 1 and no mutation. It uses the existing path-backup transaction semantics to rename every candidate to a unique same-parent quarantine entry without following symlink targets. Only after every candidate has been quarantined does it commit by recursively removing backups. A quarantine-rename failure rolls all earlier renames back and exits 1 with no removals. Backup deletion is best effort like the existing install transaction: a residual backup is reported with its exact path and status 1, while already deleted candidates remain removed; no completion marker is written.

A successful apply prints one `removed legacy skill: <absolute path>` line per candidate followed by `Legacy skill migration complete: <N> removed.` It exits 0 when candidates were removed or when none exist. Running it again is therefore idempotent and prints `Legacy skill migration complete: 0 removed.` No marker, state record, provenance, adopted ownership, or historical digest data is created; once-per-machine is an operator procedure, not persistent workflow state. JSON output is out of scope for this one-time command. Any parse error, unsafe root, enumeration error, containment failure, rename failure, backup-removal failure, or rollback failure exits 1; dry-run and successful apply exit 0.

This name-only authority ends at the migration module boundary. Ordinary reconciliation and uninstall still require schema-v2 records and exact destination verification; purge still requires its runtime, target, or current retrieved-manifest ownership proofs; `agentgear skill get` still verifies catalog pins and content digests. Shared deletion helpers must accept an explicit migration-authority token or remain private to the migration module so future callers cannot accidentally reuse whitelist-only deletion.

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
- target build layouts contain exactly the fourteen entry skills while universal contains every canonical skill;
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

Later-round design review may use an ordinary diff between immutable design artifacts or commits as navigation evidence. The complete current artifact remains authoritative. If repository state may have changed, the reviewer rechecks evidence required by the current finding rather than relying on a global snapshot claim.

## End-to-end flows

### Manual receiver flow

1. The user invokes check-waypost-messages; the harness loads only its small bootstrap.
2. The agent claims one delivery and applies the strict envelope parser.
3. For a valid token, it invokes agentgear skill get -- check-waypost-messages action:<token> with argv-safe arguments.
4. The alias resolves directly to the owning executable selector, or to one tiny discriminator selector for the six branching actions listed above.
5. The agent retrieves any additional exact skill/selector pairs named by that stage, optionally batching adjacent needs in one ordered invocation, executes them, and settles the claim.
6. After compaction, the agent repeats the alias or selector lookup. No installation path or file-read cache is required.

### Direct workflow start

1. The user invokes an entry such as tech-design-workflow.
2. Its bootstrap retrieves agentgear skill get tech-design-workflow start.
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
- A malformed Action header uses the fixed invalid-envelope selector; raw message text is never interpolated into a command.
- A valid but unknown Action uses the fixed unknown-action selector after status 2.
- A claimed delivery whose routing cannot be loaded is failed when supported, otherwise released and reported; it is not acknowledged as completed.
- A prompt-only skill explicitly exposed without a working launcher produces an actionable bootstrap error; --no-launcher warns during installation.
- A failed authoritative update rolls back owned withdrawals, new writes, runtime publication, and installation state.
- A recorded path that no longer matches its ownership record blocks ordinary withdrawal and is preserved. Only the separately invoked legacy migration may remove an exact whitelisted immediate child by name.
- Duplicate selector or alias metadata fails validation, build, and runtime lookup. Scan order is never semantic.
- A missing or dependency-broken script named only by a prompt-only selector fails staged-runtime validation.
- agentgear skill get agent-deck never returns unverified upstream content; an unavailable network with no valid materialization or staged copy fails without changing targets, published runtimes, or installation state. A successful first retrieval may create only the verified retrieved-skills materialization.
- A corrupt or locally changed retrieved-skill materialization blocks reuse, is preserved by full purge, and makes that purge exit 1 after unrelated verified owned artifacts are removed; target-limited purge does not inspect it.

## Compatibility

Codex, Claude Code, Gemini CLI, OpenCode, Antigravity, and Kiro continue to discover their existing skill directory formats. The discovery change is the smaller exact entry set after default or pack installation. Skill selector output is plain Markdown and harness-neutral.

Claude ordinary repeated Skill calls are not presented as faulty or repeatedly reinjecting full skill bodies. Compaction recovery may reload active material, and smaller bootstraps reduce that recovery payload without changing Claude-specific semantics.

All current Agentgear-owned names remain canonical, listable through agentgear list, and explicitly installable with --skill. Their detailed instructions are addressable through skill selectors, with action aliases additionally available under check-waypost-messages. The upstream agent-deck name is listed as an upstream retrievable skill and uses skill get rather than --skill installation. The fourteen accepted canonical entries remain installed by default.

No Waypost message envelope or current Action token is renamed. The action-alias set makes current routing explicit and rejects unsupported retired tokens.

Third-party tools may read dist/universal/skills as canonical source input, but must not install it as a runnable skill collection. Executable consumers use the same-release npm package or normal installer. Target-specific layouts intentionally represent only the minimal entry surface and are likewise not standalone without the matching launcher/runtime.

Users who need the host documentation explicitly run agentgear skill get agent-deck; doing so returns its content without adding a fifteenth discoverable skill.

Installation state stays schema version 2. Canonical selector lookup creates no files and stores no cache. Upstream no-selector retrieval may create only the verified retrieved-skills materialization. Authoritative pack reconciliation may remove an older explicitly installed prompt-only managed skill; this is deliberate requester-approved compatibility behavior.

## Tests and acceptance gates

Add or update tests for:

1. selector frontmatter parsing, contained traversal, symlink rejection, deterministic selector listing, exact canonical and alias lookup, frontmatter removal, trailing-newline normalization, JSON output, and status 1 versus status 2 failures;
2. agentgear skill get/list from a source checkout, staged physical release, shared current launcher, and copy-fallback wrapper, including no-selector overview, one-selector plain output, repeated and multi-selector caller order, exact agentgear skill: <skill>/<selector> labels, two-space body indentation, one empty line between blocks, and atomic unknown-selector failure with empty stdout;
3. agentgear skill get agent-deck from an existing verified materialization, a verified immutable-runtime copy, and a fresh pinned fetch, including the complete multi-file tree, required Base directory for this skill preamble, JSON resourceBase, atomic concurrent creation, offline reuse, digest/manifest corruption, unknown selector status 2, no mutation of published runtimes, no target write, and no installation-state exposure record;
4. catalog exposure validation, global alias uniqueness, list --json reporting, and the exact fourteen-entry set with no implicit upstream host skill;
5. the complete current action-alias set, with every exact message-template Action covered and every alias target present; include all current design, review, browser, plan, delegation, advisory, group, and result actions rather than representative samples;
6. strict receiver parsing: missing, duplicate, case-variant, malformed, overlong, whitespace-bearing, and shell-metacharacter Action values never reach dynamic lookup; a valid token uses one argv element after --;
7. direct one-lookup routing for one-to-one actions and small discriminator routing only for browser_check_report, design_spec_review_context_recovery_requested, design_spec_review_requested, group_message_available, rework_required, and stop_recommended;
8. implicit/default all installation exposing exactly the fourteen accepted canonical entry names on every target, and each explicit pack exposing exactly the entry subset in its resolved closure: core exposes its six entries, workflow exposes its eight entries, browser exposes the same eight through workflow inclusion, and explicit pack unions plus --skill expose the corresponding union; agent-deck is never implicit in any case;
9. explicit installation of a prompt-only canonical skill, mixed pack-plus-skill retention for that invocation, explicit-skill-only additive behavior, and later authoritative pack withdrawal;
10. schema-v2 pre-change full-pack fixtures proving install/update reconciliation and uninstall --pack workflow/browser/all remove recorded, ownership-matching legacy prompt-only and historical agent-deck links;
11. ownership safety for missing destinations, matching links, matching copies, mismatched links, unmanaged directories, and --force not widening withdrawal;
12. transactional rollback after an owned withdrawal when a later target write, launcher publication, or state save fails;
13. build output, which represents the implicit all selection, containing all canonical skills under dist/universal as source material and exactly the fourteen accepted entries under every target layout, with no upstream agent-deck directory and a generated universal warning that rejects copy-as-install usage;
14. retrieved-skills lifecycle: exact content-addressed layout and manifest, immutable validated reuse, no harness discovery path overlap, retrieval-only/state-null full purge, full purge with installed targets, target-limited purge retaining global materializations, current-catalog ownership proof, preservation of older or unknown pins, unchanged owned removal, changed/corrupt preservation with status 1 but no block on unrelated owned deletion, symlink and unexpected-shape rejection, quarantine rollback on removal failure, and no effect from ordinary install, update, link, or non-purge uninstall;
15. entry and slice byte limits, referenced skill/selector pairs, and safe fully qualified alias grammar;
16. staged runtime validation of scripts referenced from entry and prompt-only slices, including failing missing-script and missing-relative-dependency fixtures;
17. Claude, Codex, and Gemini permission output containing agentgear skill get, retaining required script grants, and dropping the removed incremental-review grant;
18. doctor/readiness behavior with Agent Deck only, Thurbox only, neither host, verified retrieved documentation, verified immutable-runtime documentation, no local documentation, and corrupt local documentation; assert that optional documentation never changes an otherwise valid readiness result, doctor performs no network fetch, and no output checks, recommends, or creates a target `agent-deck/SKILL.md`;
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

Rollback is a normal install or link of the preceding pinned release. Schema-v2 state remains readable. The preceding installer stages its own snapshot and can expose its historical full selection again. A mismatched or unmanaged path remains untouched in either direction. No Waypost data, workflow history, or user repository data is migrated or deleted.

## Alternatives rejected

Moving large SKILL.md bodies into ordinary references without a lookup API is insufficient because Codex provides no cache guarantee and recovery still depends on installation-specific paths.

Treating Claude's post-compaction restoration as a defect is rejected. It is reasonable recovery behavior; the redesign is justified by minimal exposure, Codex repeated context pressure, smaller recovery payloads, and a common explicit lookup path.

Installing a generated monolithic router skill is rejected because it recreates a large repeatedly loaded prompt. Distributed aliases resolve one-to-one actions directly to their owning slices without a second source of routing truth.

Mapping every action through a receiver-owned routing selector is rejected because it adds a needless second skill get. Only actions with a real message discriminator use a small routing selector.

Automatically exposing the pinned upstream agent-deck skill is rejected because it creates a fifteenth default entry, adds roughly 61 KiB of prompt text, and makes host availability silently change the public skill surface. Internal verified staging is sufficient for existing runtime reuse needs.

Removing all access to the upstream skill is also rejected. Explicit agentgear skill get agent-deck preserves on-demand documentation access without installing it or making every harness session discover it.

Adding a workflow interpreter or state machine is rejected because the requested behavior is document disclosure. The agent and existing workflow messages remain the execution engine and state context.

Moving Agentgear routes into waypost doc is rejected because it crosses the transport/workflow ownership boundary.

Generating a persistent selector index or cache is rejected because it creates invalidation and migration work. Restricted frontmatter plus per-invocation indexing is sufficient at repository scale.

Treating dist/universal/skills as a runnable full-tree installation is rejected because its bootstraps depend on the same-release launcher. Keeping it explicitly source-only avoids a split-version support contract without duplicating a launcher bundle inside dist.

Adding installation provenance solely to distinguish historical explicit prompt-only selections is rejected by requester decision. Authoritative current pack selection is simpler and acceptable for the sole current user.

Using a long-lived historical upstream pin or digest catalog solely to delete legacy paths is rejected. The one-time migration command uses the requester-approved fixed name whitelist only within its bounded target roots, while ordinary commands retain evidence-based ownership.

Keeping the prototype's incremental evidence cache is rejected because it adds state and per-file bookkeeping unrelated to prompt disclosure and cannot prove that unrecorded repository context remains unchanged.
