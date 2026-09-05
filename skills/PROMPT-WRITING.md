# Prompt Writing Notes

Maintenance notes for writing `SKILL.md` and related workflow prompts.

This file is for prompt authors, not for the executing agent.

## Core Rule

Write the smallest prompt that is still unambiguous at runtime.

First identify the prompt's core objective, then judge the prompt against it. State that objective and only decision-relevant constraints in compact, high-signal wording suited to the actual situation and reader. Do not prescribe steps or explain details an AI can safely infer; leave room to adapt. Keep deliberate redundancy only when it materially reinforces priority or useful reasoning.

Good prompt writing optimizes for all three:
- low token cost
- easy parsing by the model
- low chance of role or workflow confusion

## Checklist

### 1. Write for the real reader

- `SKILL.md` is runtime text for the agent executing that skill now
- do not write from the prompt maintainer's point of view
- do not leave author notes such as:
  - "this file intentionally..."
  - "move this later..."
  - "future cleanup..."
  - "the script below is for planner only"

If a note is for maintainers, put it in `README.md` or another maintenance doc.

### 2. Keep it short, but easier to execute

- prefer short, direct wording
- remove repeated restatements
- prefer one clear rule over several near-duplicates
- use structure, bullets, and light pseudo-code when that makes execution clearer
- do not compress so hard that the runtime path becomes implicit

Good:

```text
recv -> execute action -> send/closeout if required -> ack claimed inbound delivery
```

Bad:

```text
After incorporating the message into working state...
```

That wording is shorter than a full rule, but too vague to execute safely.

### 3. Do not mix protocol with role logic

- shared protocol files define transport, envelope, lifecycle, and common sequencing
- action skills define role-specific business behavior
- requester message bodies should carry task facts and constraints, not the receiver's own prompt

### 4. Do not leak another role's implementation details

- a role should not need to inspect another role's script to decide what to do
- if role A needs runtime guidance, put it in role A's action skill
- do not mention another role's internal script flags unless the current role really executes that script

### 5. Make the normal path explicit

- the default happy path must be obvious
- do not make the agent discover the path by reading `--help`, scanning env vars, or searching the repo first
- write what to do first, then mention fallback exploration only on failure

Good:
- require target session through MCP
- send message
- stop

Bad:
- check `--help`
- inspect env
- read docs
- then maybe send

### 6. Remove false choices

If the workflow only supports one valid strategy, write that strategy directly.

Do not leave room for the agent to improvise between several "possible" options.

### 7. Prefer positive defaults over unnecessary prohibitions

- when a clear positive default is enough, write the default behavior directly
- do not pile on negative constraints unless they prevent a real, observed misunderstanding
- too many "do not ..." rules make prompts noisy and can accidentally suggest the forbidden path
- add a negative constraint only when the positive rule alone has proved insufficient or ambiguous

### 8. Be precise about completion and `ack`

- default rule: `waypost_ack` only after the message's required workflow action is complete
- when you mean message lifecycle, say `ack claimed inbound delivery`, not just `ack`
- never imply a sender-side `ack` after `waypost_send`; sender-side completion is `waypost_send` success
- do not use vague wording such as:
  - "incorporated into working state"
  - "picked up"
  - "processed enough"
- if a specific action has a serialized `ack` point, that action skill should name it precisely

### 9. Preserve async boundaries

- distinguish message delivery from task completion
- write only claims about timing, ownership, and receiver state that the prompt can establish
- keep transport mechanics in the shared protocol; keep role completion in the action skill

### 10. Protect shared workspace state

- when another agent may still be working in the same workspace, do not tell the current agent to alter that workspace state
- "do not switch branch" is too narrow
- the real rule is: do not change shared workspace state unless this role now owns it

That includes:
- branch state
- file contents
- cleanup that can disrupt another active agent

### 11. Prefer authoritative tools over narrated procedures

- if correctness depends on a script/tool, tell the agent to use that script/tool
- do not describe a loose manual equivalent alongside it
- otherwise the agent may decide its own version is "close enough"

### 12. Avoid duplicated guidance

- one rule should have one owner
- repeated wording across protocol, action skill, message template, and README will drift
- if a rule must be repeated, keep one source authoritative and keep the repeat minimal
- Agentgear skill text is stable by default; tell agents to remember and reuse loaded guidance, and reload only when they no longer remember it, the user asks, or there is evidence it changed
- an environment-adaptive skill may state its own narrower refresh boundary when current PATH/workspace evidence materially changes its advice; keep that exception local to the owning bootstrap

Repeated near-duplicates are dangerous because the model may synthesize a third meaning.

### 13. Distinguish runtime docs from maintenance docs

Use runtime docs for:
- execution steps
- runtime constraints
- decision rules
- command/tool invocation

Use maintenance docs for:
- why the prompt is shaped this way
- pitfalls we have seen before
- future cleanup ideas
- authoring guidance

### 14. Keep agent-specific guidance optional

Put a best-effort agent appendix in a separate Markdown file below the owning
skill's `references/` directory:

```markdown
---
agent: codex
append-to-selector: review
---

## For Codex only

Additional guidance for a known Codex behavior.
```

- the target selector must remain complete without the appendix
- use the required `For <agent> only` heading so accidental loading is harmless
- do not declare message headers, selector aliases, or workflow behavior in an appendix
- runtime agent detection may omit an appendix and must never be required for correctness

### 15. Keep environment guidance advisory

Put candidate-specific guidance in a separate Markdown file below the owning
skill's `references/` directory:

```markdown
---
runtime-command: ast-grep
append-to-selector: start
---

## Runtime guidance: ast-grep

Candidate-specific advice.
```

- declare the command in catalog `runtimeCommands`
- keep the target selector complete when every candidate appendix is absent
- describe the tool as a useful candidate, not a mandatory choice; a built-in capability may be better
- do not turn command availability into permission, trust, or authorization
- use a readiness predicate only when the catalog/provider explicitly supports the required workspace state
- never create external state such as a CodeGraph index merely to make a candidate ready
- do not write fallback tool names into the base selector unless the behavior genuinely requires that named tool

### 16. Make autonomy and completion explicit across models

Maintain one complete behavioral contract for GPT-6 Astra and GPT-5.6. Prefer
clarifying the shared prompt over model detection or parallel prompt variants.

- State the outcome, material boundaries, and observable completion condition.
- Let the executing role resolve routine technical choices from evidence and
  continue authorized work. Name the scope, product, permission, or ownership
  decisions that require user input; uncertainty alone is not a stop condition.
- Keep required fields, exact protocol tokens, serialized actions, human gates,
  and async handoffs explicit. Shortening a prompt must not erase these rules.
- Distinguish requirements from recommendations. Apply relevant skill guidance
  within the user's authorized scope and the harness instruction hierarchy;
  do not turn a guideline into a new approval gate. When a rule blocks work,
  identify its source and the concrete conflict.
- Describe when delegation pays off and who owns integration in the skill that
  selects execution surfaces. Preserve serial workspace and review policies.
- Bound verification by acceptance criteria, change risk, and required project
  checks. Further checks need new evidence or an unresolved risk; passing checks
  should lead to the next required delivery step.
- Separate user-facing style from machine-facing output contracts. Prefer a
  concise outcome and actionable evidence for the user; preserve required report
  fields and enough detail for another role to act.

Model guidance motivates an audit, not a blanket rewrite. Keep reasoning/model
configuration in the existing resolver profiles, outside runtime prose.

### 17. Define persistence before the first implementation

GPT-6 Astra may return after a first implementation when inspection, repair, or
delivery remains. Put those activities in the completion contract before work
starts, and name what to explore and where to stop. Do not insert a review stop
after the first implementation unless review is an actual decision point. In
unattended mode, continue through reversible implementation, inspection, repair,
and required checks; report only at a blocker, authorization gate, checkpoint,
or final delivery.

## Cross-Model Validation

For behavioral prompt changes, compare the previous and revised prompts on the
same representative tasks with GPT-6 Astra and the deployed GPT-5.6 variants.
Hold tools, context, and each model's configuration constant between prompt
versions. Include routine ambiguity, a real user decision, missing required
workflow identity, a small change, and an async handoff. Check task completion,
unnecessary questions, unauthorized assumptions, verification scope, output
contracts, and tool cost. Report untested models explicitly; build and static
checks establish packaging correctness, not behavioral compatibility.

Reference for this audit:
- [OpenAI GPT-6 Astra prompting best practices](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra), accessed 2026-09-05.
- [PrompTessor prompting guide](https://promptessor.com/blog/gpt-6-astra-prompting-guide), secondary practical examples, accessed 2026-09-05.

## Common Failure Modes

Before landing a prompt change, check for these:

- Did this text accidentally become maintainer notes instead of runtime instructions?
- Did we make the agent infer a choice that should be fixed by policy?
- Did we duplicate another skill's logic instead of referencing it?
- Did we tell the receiver how another role works internally?
- Did we preserve async boundaries without duplicating transport rules?
- Did we allow the agent to mutate shared workspace state while another agent may still own it?
- Did we describe manual steps where a script/tool should be authoritative?
- Did we make `ack` happen before the workflow action is actually complete?
- Did we create a new place where policy can drift?

## Review Standard

Prompt changes should be reviewed like code:
- ambiguous wording is a bug
- duplicated rules are a bug
- wrong-reader text is a bug
- hidden strategy choice is a bug
- runtime/maintenance leakage is a bug
