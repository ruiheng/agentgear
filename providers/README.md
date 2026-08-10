# Provider Adapters

Canonical skill payloads live in `../skills/`. Add files here only when a host
needs behavior that cannot be represented by the common Agent Skills package.

The build copies the common payload into every target today. A future adapter
may transform frontmatter, add a hook manifest, or emit a provider-native agent
format. Keep that adapter narrow and generate its output into `dist/`.

Host-specific CLI mappings also live here. Keep command construction in the
adapter while parsing, invocation, and normalized result handling remain in the
common CLI.
