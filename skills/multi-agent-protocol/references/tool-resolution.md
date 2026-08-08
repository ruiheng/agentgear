# Launch Candidate Resolution

Use this reference only when a workflow creates a new collaborator session.
The workflow role (`planner`, `reviewer`, `coder`, and so on) is resolved here;
Waypost does not map roles or read this configuration.

- Reuse a confirmed existing session without resolving a replacement candidate.
- Keep model/provider/version defaults in the shared profile, not an action
  skill.
- Resolve a new role with:

  ```bash
  agentgear run multi-agent-protocol resolve-tool-command.js --role <role> --profile <profile> --workdir <target_workdir> --show-list --format json
  ```

  Omit `--profile` when none is set. Keep an explicit full command unchanged
  when an action accepts one.
- List configured roles with:

  ```bash
  agentgear run multi-agent-protocol resolve-tool-command.js --list-roles --format text
  ```

  JSON output is an object with a `roles` array.
- Set up the user-local override once with:

  ```bash
  agentgear run multi-agent-protocol resolve-tool-command.js --init-local-config
  ```

  This copies the bundled example to the XDG Agentgear config directory and
  refuses to overwrite an existing file.
- Check the merged resolver configuration with:

  ```bash
  agentgear run multi-agent-protocol resolve-tool-command.js --check-config --format text
  ```

  The check validates resolver structure. If `thurbox-cli` is available, it
  also compares each candidate's `thurbox_agent_key` with Thurbox's local
  `agents.toml` (honoring `THURBOX_CONFIG_DIR` when set); missing or unknown
  keys are warnings only. This explicit maintenance check is the one place
  Agentgear reads that host configuration.
- `<target_workdir>` is the workdir passed to `session_create`.
- JSON includes ordered `tool_candidates`. Each candidate has `command` (the
  full command line) and may have `thurbox_agent_key`. That key is opaque
  user-maintained configuration; workflow code must not infer it from the
  command or inspect Thurbox configuration to validate it.
- After the parent resolves as ready, select the first usable candidate for its
  returned host:
  - for a command-launching host, pass `full_command_line = candidate.command`;
  - for Thurbox, require and pass
    `thurbox_agent_key = candidate.thurbox_agent_key`.
  Passing both fields is valid; Waypost consumes only the selected host's
  field.
- Record the selected profile, command, and Thurbox key in workflow context
  when they are needed for a later recovery. Do not put them in user-facing
  messages.
- Retry a later candidate only after a normal create rejection before a session
  is created. Never retry after `created_unverified`,
  `create_recovery_required`, or `ready_unverified`.
- Pass `--workdir` for the target session. Pass `--target-path <PATH>` only when its PATH is known.
- Static checking does not run commands. Filter only trusted-context misses; retain dispatcher-/command-path misses in `tool_candidates` as `unverified_tool_cmds`, and preserve `unavailable_tool_cmds` as diagnostics.
- `strategy` defaults to `ordered`, the only supported strategy; omit it unless a future strategy requires an explicit choice.
- Local profile candidates replace by default. Set `merge = "prepend"` or `merge = "append"` with `candidates` to extend the prior list.
- Thurbox users add the key in their own `tool-profiles.local.toml`; a missing
  key is an actionable configuration error, not a reason for the workflow to
  guess.
- The action skill owns the role, parent, workspace, reuse policy, and
  create/require choice.
