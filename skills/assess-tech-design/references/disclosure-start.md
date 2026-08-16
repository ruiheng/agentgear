---
skill-selector: start
selector-summary: Complete assess-tech-design instructions, part 1.
---

# Assess Technical Design

Start from the original problem; assess the current technical design specification against the latest accepted goals, constraints, and decisions—not the drafting history.

## Scope

Require:

- exact readable target set: every document or asset needed to judge the technical design specification
- current accepted intent: original problem + latest accepted goals, constraints, and decisions
- exact snapshot/commit when version can change the conclusion

Ask one short question only when missing context would materially change the conclusion. Use available evidence; do not assume.

Stay advisory and read-only. Leave edits, Git, archival, and workflow routing to the caller.

## Assessment

Assess only relevant areas:

- core approach; whether goals/requirements are sound, appropriately scoped, or should be split
- material rationale, user fit, simplicity/over-design, ownership, boundaries, cohesion, and coupling
- flexibility/foresight: readiness for credible future change within demonstrated need
- persisted data/state and configuration: need, migration/rollback, defaults, deployment, and operations
- sensitive and privacy data: categories and necessity, allowed uses, lifecycle, and trust boundaries across collection, processing, storage, logs/telemetry, backups, export/sharing, retention, and deletion; access, encryption, residency, third parties, user controls, auditability, and failure/incident handling
- compatibility in both directions—new-to-old and old-to-new data, configuration, and interfaces—and whether it is necessary
- benefits, risks, mitigations/rollback, alternatives, and key tradeoffs
- user-owned decisions, options, and consequences

Use `None` for no relevant impact or concern; use `Missing information` when evidence is insufficient. Cite targets and evidence with full paths or URIs.

## Report

Keep the report compact. Focus on material issues, tradeoffs, and decisions; do not restate the design specification.

~~~markdown
# Technical Design Assessment

## Targets And Intent
- Targets:
  - <full path or URI>
- Snapshot/commit: <if relevant>
- Accepted intent: <original problem; latest accepted goals, constraints, and decisions>

## Core And Scope
[approach, fit, simplification/splitting opportunities, or None]

## Flexibility And Foresight
[readiness for credible future change within demonstrated need, or None]

## Material Impacts
- Data/state: [impact, migration/rollback, or None]
- Configuration/operations: [impact, or None]
- Compatibility: [both directions and need, or None]

## Sensitive And Privacy Data
[categories, necessity/minimization, allowed uses, lifecycle and trust boundaries, controls, third parties, user controls, and failure/incident handling, or None]

## Risks And Tradeoffs
[benefits, risks, mitigations, alternatives, and tradeoffs, or None]

## Decisions Needed
- [option and consequence, or None]

## Missing Information
- [evidence needed to conclude, or None]
~~~
