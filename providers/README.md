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

`claude-compact-memory.mjs`, `codex-compact-memory.mjs`, and
`devin-compact-memory.mjs` are per-host spec tables for Agentgear's
compact-memory hooks: each declares its config path, managed event table, and
how managed groups are identified. `compact-memory-host.mjs` owns the shared
install/merge/uninstall/doctor pipeline those specs feed.
`hook-json-file.mjs` holds the shared safe JSON document machinery, and
`managed-hook-command.mjs` holds the shared launcher command and ownership
detection used by hosts whose hook groups carry no description field. Devin's
XDG config home resolution is shared with the workflow permission scripts in
`skills/multi-agent-protocol/scripts/devin-paths.mjs`.
