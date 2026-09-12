# Provider Adapters

Canonical skill payloads live in `../skills/`. Add files here only when a host
needs behavior that cannot be represented by the common Agent Skills package.

The build copies the common payload into every target today. A future adapter
may transform frontmatter, add a hook manifest, or emit a provider-native agent
format. Keep that adapter narrow and generate its output into `dist/`.

Host-specific CLI mappings and lifecycle inspection live here. Keep workflow
target selection and archive orchestration in the owning skill; provider
metadata lookup, deletion guards, and host-native cleanup stay in the adapter.

`permission-adapters/` renders the common development permission-preset schema
into Codex, Claude Code, Gemini CLI, Agy, and Devin CLI configuration. Preset
discovery, schema validation, target selection, and transactional
orchestration remain in `cli/lib/`; native paths, formats, and settings merge
behavior stay here.

`codex-compact-memory.mjs` and `devin-compact-memory.mjs` own the Codex- and
Devin-native hooks paths, document shapes, managed-group merge, and platform
launcher checks for Agentgear hook setup; `hook-json-file.mjs` holds the shared
safe JSON document machinery. Devin's XDG config home resolution is shared
with the workflow permission scripts in
`skills/multi-agent-protocol/scripts/devin-paths.mjs`.
