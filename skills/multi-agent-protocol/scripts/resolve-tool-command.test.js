import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkToolConfig,
  expandCommandTemplate,
  initializeLocalConfig,
  inspectToolCommand,
  listConfiguredRoles,
  loadToolConfig,
  parseThurboxAgentsToml,
  parseTomlValue,
  parseToolProfilesToml,
  mergeToolConfigs,
  resolveAgentgearConfigDir,
  resolveCwdLocalConfigPath,
  resolveDefaultLocalConfigPaths,
  resolveThurboxConfigDir,
  resolveThurboxAgentsConfigPath,
  resolveToolCommand,
  runCli,
} from "./resolve-tool-command.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function captureStdout(callback) {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };

  try {
    callback();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}

test("CLI prints help without loading the default config", () => {
  const missingConfig = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-help-")),
    "missing.toml"
  );
  const results = ["--help", "-h"].map((argument) =>
    captureStdout(() => runCli(["--config", missingConfig, argument]))
  );

  for (const result of results) {
    assert.match(result, /Usage: resolve-tool-command\.js/);
    assert.match(result, /--profile <profile>/);
    assert.match(result, /-h, --help/);
  }

  assert.equal(results[0], results[1]);
});

test("listConfiguredRoles returns sorted configured role names", () => {
  assert.deepEqual(
    listConfiguredRoles({
      roles: { reviewer: "reviewer_default", coder: "coder_default" },
    }),
    ["coder", "reviewer"]
  );
});

test("CLI lists merged configured roles independently", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-roles-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const localConfigPath = path.join(tmpDir, "tool-profiles.local.toml");
  fs.writeFileSync(
    configPath,
    `version = 1

[roles]
worker = "coder_default"
reviewer = "reviewer_default"
`,
    "utf8"
  );
  fs.writeFileSync(
    localConfigPath,
    `[roles]
coder = "coder_default"
`,
    "utf8"
  );

  const jsonOutput = captureStdout(() =>
    runCli([
      "--config",
      configPath,
      "--local-config",
      localConfigPath,
      "--list-roles",
    ])
  );
  assert.deepEqual(JSON.parse(jsonOutput), {
    roles: ["coder", "reviewer", "worker"],
  });

  const textOutput = captureStdout(() =>
    runCli([
      "--config",
      configPath,
      "--local-config",
      localConfigPath,
      "--list-roles",
      "--format",
      "text",
    ])
  );
  assert.equal(textOutput, "coder\nreviewer\nworker\n");
});

function availableInspection(toolCmd) {
  return {
    availability: "available",
    tool_cmd: toolCmd,
    executable: toolCmd.split(/\s+/, 1)[0],
  };
}

test("resolveAgentgearConfigDir follows XDG config conventions", () => {
  assert.equal(
    resolveAgentgearConfigDir({ XDG_CONFIG_HOME: "/tmp/custom-config" }, "/home/tester"),
    "/tmp/custom-config/agentgear"
  );
  assert.equal(
    resolveAgentgearConfigDir({}, "/home/tester"),
    "/home/tester/.config/agentgear"
  );
});

test("resolveThurboxAgentsConfigPath follows XDG config conventions", () => {
  assert.equal(
    resolveThurboxAgentsConfigPath(
      { XDG_CONFIG_HOME: "/tmp/custom-config" },
      "/home/tester"
    ),
    "/tmp/custom-config/thurbox/agents.toml"
  );
  assert.equal(
    resolveThurboxAgentsConfigPath({}, "/home/tester"),
    "/home/tester/.config/thurbox/agents.toml"
  );
});

test("resolveThurboxAgentsConfigPath honors Thurbox's config directory override", () => {
  const env = {
    THURBOX_CONFIG_DIR: "/srv/thurbox-config",
    XDG_CONFIG_HOME: "/tmp/ignored",
  };
  assert.equal(resolveThurboxConfigDir(env, "/home/tester"), "/srv/thurbox-config");
  assert.equal(
    resolveThurboxAgentsConfigPath(env, "/home/tester"),
    "/srv/thurbox-config/agents.toml"
  );
});

test("resolveDefaultLocalConfigPaths layers user then current directory overrides", () => {
  assert.deepEqual(
    resolveDefaultLocalConfigPaths(
      { XDG_CONFIG_HOME: "/tmp/custom-config" },
      "/home/tester",
      "/workspace/project"
    ),
    [
      "/tmp/custom-config/agentgear/tool-profiles.local.toml",
      "/workspace/project/tool-profiles.local.toml",
    ]
  );
  assert.equal(
    resolveCwdLocalConfigPath("/workspace/project"),
    "/workspace/project/tool-profiles.local.toml"
  );
});

test("initializeLocalConfig copies the example without overwriting a user file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-init-"));
  const examplePath = path.join(tmpDir, "example.toml");
  const destinationPath = path.join(tmpDir, "nested", "tool-profiles.local.toml");
  fs.writeFileSync(examplePath, "[roles]\nreviewer = \"reviewer_local\"\n", "utf8");

  assert.equal(
    initializeLocalConfig({ destinationPath, examplePath }),
    destinationPath
  );
  assert.equal(
    fs.readFileSync(destinationPath, "utf8"),
    "[roles]\nreviewer = \"reviewer_local\"\n"
  );
  assert.throws(
    () => initializeLocalConfig({ destinationPath, examplePath }),
    /refusing to overwrite existing local config/
  );
});

test("parseToolProfilesToml reads roles and profile candidate arrays", () => {
  const config = parseToolProfilesToml(`
version = 1

[roles]
planner = "planner_default"

[profiles.planner_default]
strategy = "ordered"
candidates = [
  "codex --model gpt-5.5",
  "codex --model gpt-5.4",
]
`);

  assert.equal(config.version, 1);
  assert.equal(config.roles.planner, "planner_default");
  assert.deepEqual(config.profiles.planner_default.candidates, [
    "codex --model gpt-5.5",
    "codex --model gpt-5.4",
  ]);
});

test("parseToolProfilesToml reads candidate tables, startup messages, and Thurbox keys", () => {
  const config = parseToolProfilesToml(`
version = 2

[profiles.reviewer_default]
strategy = "ordered"

[[profiles.reviewer_default.candidates]]
command = "codex --model gpt-5.6-luna"
startup_message = "Follow the review workflow.\\nWait for the review request."
thurbox_agent_key = "codex"

[[profiles.reviewer_default.candidates]]
command = "claude --model sonnet"
`);

  assert.equal(config.version, 2);
  assert.deepEqual(config.profiles.reviewer_default.candidates, [
    {
      command: "codex --model gpt-5.6-luna",
      startup_message:
        "Follow the review workflow.\nWait for the review request.",
      thurbox_agent_key: "codex",
    },
    { command: "claude --model sonnet" },
  ]);
});

test("parseThurboxAgentsToml reads configured agent names", () => {
  assert.deepEqual(
    parseThurboxAgentsToml(`
default = "claude"

[[agents]]
name = "claude"
command = "claude"

[[agents]]
name = "codex" # Inline comments are allowed.
command = "codex"

[[agents]]
name = "codex"
command = "codex --model gpt-5.6"
`),
    ["claude", "codex"]
  );
});

test("checkToolConfig warns about missing and unknown Thurbox agent keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-check-"));
  const thurboxConfigPath = path.join(tmpDir, "thurbox", "agents.toml");
  fs.mkdirSync(path.dirname(thurboxConfigPath), { recursive: true });
  fs.writeFileSync(
    thurboxConfigPath,
    `[[agents]]
name = "codex"
command = "codex"
`,
    "utf8"
  );

  const checked = checkToolConfig(
    {
      version: 2,
      roles: { reviewer: "reviewer_default" },
      templates: {},
      profiles: {
        reviewer_default: {
          candidates: [
            { command: "codex --model gpt-5.6", thurbox_agent_key: "codex" },
            { command: "claude --model sonnet" },
            { command: "agy", thurbox_agent_key: "unknown" },
          ],
        },
      },
    },
    {
      thurboxInspection: { availability: "available" },
      thurboxConfigPath,
    }
  );

  assert.equal(checked.valid, true);
  assert.deepEqual(checked.thurbox.agent_keys, ["codex"]);
  assert.deepEqual(
    checked.warnings.map(({ code, profile, candidate_index, thurbox_agent_key }) => ({
      code,
      profile,
      candidate_index,
      thurbox_agent_key,
    })),
    [
      {
        code: "missing_thurbox_agent_key",
        profile: "reviewer_default",
        candidate_index: 1,
        thurbox_agent_key: undefined,
      },
      {
        code: "unknown_thurbox_agent_key",
        profile: "reviewer_default",
        candidate_index: 2,
        thurbox_agent_key: "unknown",
      },
    ]
  );
});

test("checkToolConfig skips Thurbox key warnings when thurbox-cli is unavailable", () => {
  const checked = checkToolConfig(
    {
      version: 2,
      roles: { reviewer: "reviewer_default" },
      templates: {},
      profiles: {
        reviewer_default: {
          candidates: [{ command: "codex --model gpt-5.6" }],
        },
      },
    },
    {
      thurboxInspection: {
        availability: "unavailable",
        reason: "not_found_on_command_path",
      },
    }
  );

  assert.deepEqual(checked, {
    valid: true,
    thurbox: {
      available: false,
      reason: "not_found_on_command_path",
    },
    warnings: [],
  });
});

test("checkToolConfig reports an unreadable Thurbox configuration as a warning", () => {
  const checked = checkToolConfig(
    {
      version: 2,
      roles: { reviewer: "reviewer_default" },
      templates: {},
      profiles: {
        reviewer_default: {
          candidates: [{ command: "codex --model gpt-5.6", thurbox_agent_key: "codex" }],
        },
      },
    },
    {
      thurboxInspection: { availability: "available" },
      thurboxConfigPath: "/tmp/thurbox/agents.toml",
      readFile() {
        throw new Error("permission denied");
      },
    }
  );

  assert.deepEqual(checked.warnings, [
    {
      code: "thurbox_agents_config_unreadable",
      agents_config_path: "/tmp/thurbox/agents.toml",
      message: "permission denied",
    },
  ]);
});

test("checkToolConfig rejects invalid resolver mappings", () => {
  assert.throws(
    () =>
      checkToolConfig(
        {
          version: 2,
          roles: { reviewer: "missing_profile" },
          templates: {},
          profiles: {},
        },
        { thurboxInspection: { availability: "unavailable" } }
      ),
    /tool role references an unknown profile/
  );
});

test("CLI check rejects an explicitly missing local override", () => {
  const missingPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-missing-local-")),
    "missing.toml"
  );
  assert.throws(
    () => runCli(["--check-config", "--local-config", missingPath]),
    /local tool profile config not found/
  );
});

test("parseToolProfilesToml reads and expands command templates", () => {
  const config = parseToolProfilesToml(`
[templates]
codex_approval = "--ask-for-approval on-request"
`);

  assert.deepEqual(config.templates, {
    codex_approval: "--ask-for-approval on-request",
  });
  assert.equal(
    expandCommandTemplate(
      "codex --model gpt-5.6 ${templates.codex_approval}",
      config.templates
    ),
    "codex --model gpt-5.6 --ask-for-approval on-request"
  );
  assert.throws(
    () => expandCommandTemplate("codex ${templates.missing}", config.templates),
    /unknown command template: missing/
  );
  assert.throws(
    () => expandCommandTemplate("codex ${templates.not-valid}", config.templates),
    /invalid command template: \$\{templates\.not-valid\}/
  );
  assert.equal(
    expandCommandTemplate(
      'PATH="${HOME}/.local/bin:$PATH" codex --token "${TOKEN:-default}"',
      config.templates
    ),
    'PATH="${HOME}/.local/bin:$PATH" codex --token "${TOKEN:-default}"'
  );
});

test("parseTomlValue accepts TOML literal strings and arrays", () => {
  assert.equal(parseTomlValue("'reviewer_local'"), "reviewer_local");
  assert.deepEqual(
    parseTomlValue(`[
  'codex -m gpt-5.4 -c model_reasoning_effort="medium"',
  "claude --model sonnet --permission-mode acceptEdits",
]`),
    [
      `codex -m gpt-5.4 -c model_reasoning_effort="medium"`,
      "claude --model sonnet --permission-mode acceptEdits",
    ]
  );
});

test("inspectToolCommand checks PATH without running the command", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-"));
  const binDir = path.join(tmpDir, "bin");
  const executablePath = path.join(binDir, "available-tool");
  const markerPath = path.join(tmpDir, "marker");
  fs.mkdirSync(binDir);
  fs.writeFileSync(executablePath, `#!/bin/sh\ntouch ${markerPath}\n`, "utf8");
  fs.chmodSync(executablePath, 0o755);

  assert.deepEqual(
    inspectToolCommand("env LEVEL=1 available-tool --flag", {
      pathEnv: binDir,
      cwd: tmpDir,
    }),
    {
      availability: "available",
      tool_cmd: "env LEVEL=1 available-tool --flag",
      executable: "available-tool",
    }
  );
  assert.equal(fs.existsSync(markerPath), false);
  assert.deepEqual(
    inspectToolCommand("missing-tool --flag", { pathEnv: binDir, cwd: tmpDir }),
    {
      availability: "unverified",
      tool_cmd: "missing-tool --flag",
      executable: "missing-tool",
      reason: "not_found_on_dispatcher_path",
    }
  );
});

test("inspectToolCommand uses trusted target context without rejecting command-scoped PATH", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-"));
  const workdir = path.join(tmpDir, "workspace");
  const binDir = path.join(workdir, "bin");
  const executablePath = path.join(binDir, "target-tool");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(executablePath, "#!/bin/sh\n", "utf8");
  fs.chmodSync(executablePath, 0o755);

  assert.deepEqual(
    inspectToolCommand("./bin/target-tool", {
      cwd: workdir,
      cwdTrusted: true,
      pathEnv: "",
    }),
    {
      availability: "available",
      tool_cmd: "./bin/target-tool",
      executable: "./bin/target-tool",
    }
  );
  assert.deepEqual(
    inspectToolCommand("./bin/missing-tool", {
      cwd: workdir,
      cwdTrusted: true,
      pathEnv: "",
    }),
    {
      availability: "unavailable",
      tool_cmd: "./bin/missing-tool",
      executable: "./bin/missing-tool",
      reason: "not_found_at_path",
    }
  );
  assert.deepEqual(
    inspectToolCommand("PATH=/opt/agent/bin agent", {
      cwd: workdir,
      cwdTrusted: true,
      pathEnv: "",
      pathTrusted: true,
    }),
    {
      availability: "unverified",
      tool_cmd: "PATH=/opt/agent/bin agent",
      executable: "agent",
      reason: "not_found_on_command_path",
    }
  );
});

test("loadToolConfig deep-merges local overrides", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-profiles-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const localConfigPath = path.join(tmpDir, "tool-profiles.local.toml");

  fs.writeFileSync(
    configPath,
    `version = 1

[roles]
reviewer = "reviewer_default"

[profiles.reviewer_default]
strategy = "ordered"
candidates = ["codex --model gpt-5.4"]
`,
    "utf8"
  );
  fs.writeFileSync(
    localConfigPath,
    `[roles]
reviewer = 'reviewer_local'

[profiles.reviewer_local]
strategy = "ordered"
candidates = ['claude --model sonnet --permission-mode acceptEdits']
`,
    "utf8"
  );

  const config = loadToolConfig(configPath, localConfigPath);
  assert.equal(config.roles.reviewer, "reviewer_local");
  assert.deepEqual(config.profiles.reviewer_local.candidates, [
    "claude --model sonnet --permission-mode acceptEdits",
  ]);
});

test("mergeToolConfigs supports replace, prepend, and append candidates", () => {
  const baseConfig = {
    version: 1,
    roles: {},
    profiles: {
      coder_default: {
        strategy: "ordered",
        candidates: ["base-first", "base-last"],
      },
    },
  };

  for (const [merge, expected] of [
    ["replace", ["local"]],
    ["prepend", ["local", "base-first", "base-last"]],
    ["append", ["base-first", "base-last", "local"]],
  ]) {
    const merged = mergeToolConfigs(baseConfig, {
      version: 1,
      roles: {},
      profiles: {
        coder_default: { merge, candidates: ["local"] },
      },
    });
    assert.deepEqual(merged.profiles.coder_default.candidates, expected);
    assert.equal(merged.profiles.coder_default.merge, undefined);
  }
});

test("loadToolConfig applies candidate merge modes across local configs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-profiles-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const userLocalConfigPath = path.join(tmpDir, "user.local.toml");
  const cwdLocalConfigPath = path.join(tmpDir, "cwd.local.toml");

  fs.writeFileSync(
    configPath,
    `version = 1

[profiles.coder_default]
strategy = "ordered"
candidates = ["base-first", "base-last"]
`,
    "utf8"
  );
  fs.writeFileSync(
    userLocalConfigPath,
    `[profiles.coder_default]
merge = "append"
candidates = ["user-last"]
`,
    "utf8"
  );
  fs.writeFileSync(
    cwdLocalConfigPath,
    `[profiles.coder_default]
merge = "prepend"
candidates = ["cwd-first"]
`,
    "utf8"
  );

  const config = loadToolConfig(configPath, [
    userLocalConfigPath,
    cwdLocalConfigPath,
  ]);
  assert.deepEqual(config.profiles.coder_default.candidates, [
    "cwd-first",
    "base-first",
    "base-last",
    "user-last",
  ]);
});

test("loadToolConfig merges v2 candidate tables with v1 string overrides", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-profiles-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const localConfigPath = path.join(tmpDir, "tool-profiles.local.toml");

  fs.writeFileSync(
    configPath,
    `version = 2

[profiles.coder_default]
strategy = "ordered"

[[profiles.coder_default.candidates]]
command = "base-tool"
startup_message = "Initialize the worker."
`,
    "utf8"
  );
  fs.writeFileSync(
    localConfigPath,
    `version = 1

[profiles.coder_default]
merge = "append"
candidates = ["local-tool"]
`,
    "utf8"
  );

  const config = loadToolConfig(configPath, localConfigPath);
  assert.deepEqual(config.profiles.coder_default.candidates, [
    {
      command: "base-tool",
      startup_message: "Initialize the worker.",
    },
    "local-tool",
  ]);
});

test("loadToolConfig applies local overrides in order", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-profiles-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const userLocalConfigPath = path.join(tmpDir, "user.local.toml");
  const cwdLocalConfigPath = path.join(tmpDir, "cwd.local.toml");

  fs.writeFileSync(
    configPath,
    `version = 1

[roles]
reviewer = "reviewer_default"

[profiles.reviewer_default]
strategy = "ordered"
candidates = ["codex --model gpt-5.4"]
`,
    "utf8"
  );
  fs.writeFileSync(
    userLocalConfigPath,
    `[roles]
reviewer = 'reviewer_user'

[profiles.reviewer_user]
strategy = "ordered"
candidates = ['codex --model gpt-5.5']
`,
    "utf8"
  );
  fs.writeFileSync(
    cwdLocalConfigPath,
    `[roles]
reviewer = 'reviewer_cwd'

[profiles.reviewer_cwd]
strategy = "ordered"
candidates = ['claude --model sonnet --permission-mode acceptEdits']
`,
    "utf8"
  );

  const config = loadToolConfig(configPath, [
    userLocalConfigPath,
    cwdLocalConfigPath,
  ]);
  assert.equal(config.roles.reviewer, "reviewer_cwd");
  assert.deepEqual(config.profiles.reviewer_user.candidates, [
    "codex --model gpt-5.5",
  ]);
  assert.deepEqual(config.profiles.reviewer_cwd.candidates, [
    "claude --model sonnet --permission-mode acceptEdits",
  ]);
});

test("loadToolConfig applies architect compatibility without overriding independent roles", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-templates-"));
  const configPath = path.join(tmpDir, "tool-profiles.toml");
  const localConfigPath = path.join(tmpDir, "tool-profiles.local.toml");
  fs.writeFileSync(
    configPath,
    `version = 2

[templates]
codex_approval = "--ask-for-approval on-request"
claude_edits = "--permission-mode acceptEdits"

[roles]
architect = "architect_default"
architect_author = "architect_default"
architect_reviewer = "architect_default"
design_pruner = "design_pruner_default"

[profiles.architect_default]
candidates = ["codex \${templates.codex_approval}"]

[profiles.architect_local]
candidates = ["claude \${templates.claude_edits}"]

[profiles.design_pruner_default]
candidates = ["agy"]
`,
    "utf8"
  );
  fs.writeFileSync(
    localConfigPath,
    `[templates]
codex_approval = "--ask-for-approval never"

[roles]
architect = "architect_local"
architect_author = "architect_author_explicit"

[profiles.architect_author_explicit]
candidates = ["codex \${templates.codex_approval}"]
`,
    "utf8"
  );

  const config = loadToolConfig(configPath, localConfigPath);
  assert.deepEqual(config.templates, {
    codex_approval: "--ask-for-approval never",
    claude_edits: "--permission-mode acceptEdits",
  });
  assert.equal(config.roles.architect, "architect_local");
  assert.equal(config.roles.architect_author, "architect_author_explicit");
  assert.equal(config.roles.architect_reviewer, "architect_local");
  assert.equal(config.roles.design_pruner, "design_pruner_default");
  assert.equal(
    resolveToolCommand({
      role: "architect_reviewer",
      inspectCommand: availableInspection,
      config,
    }).resolved_tool_cmd,
    "claude --permission-mode acceptEdits"
  );
  assert.equal(
    resolveToolCommand({
      role: "architect_author",
      inspectCommand: availableInspection,
      config,
    }).resolved_tool_cmd,
    "codex --ask-for-approval never"
  );
  assert.equal(
    resolveToolCommand({
      role: "design_pruner",
      inspectCommand: availableInspection,
      config,
    }).resolved_tool_cmd,
    "agy"
  );
});

test("resolveToolCommand preserves explicit commands unchanged", () => {
  const resolved = resolveToolCommand({
    command: "codex --model gpt-5.5 --ask-for-approval on-request",
    profile: "reviewer_default",
    inspectCommand: availableInspection,
    config: { version: 1, roles: {}, profiles: {} },
  });

  assert.deepEqual(resolved, {
    tool_profile: "reviewer_default",
    resolved_tool_cmd: "codex --model gpt-5.5 --ask-for-approval on-request",
    resolution_source: "explicit_command",
    fallback_index: 0,
    candidate_count: 1,
  });
});

test("resolveToolCommand uses the role default profile", () => {
  const resolved = resolveToolCommand({
    role: "reviewer",
    showList: true,
    inspectCommand: availableInspection,
    config: {
      version: 1,
      roles: { reviewer: "reviewer_default" },
      profiles: {
        reviewer_default: {
          strategy: "ordered",
          candidates: ["codex --model gpt-5.4", "codex --model gpt-5.5"],
        },
      },
    },
  });

  assert.equal(resolved.tool_profile, "reviewer_default");
  assert.equal(resolved.resolved_tool_cmd, "codex --model gpt-5.4");
  assert.deepEqual(resolved.tool_candidates, [
    { command: "codex --model gpt-5.4" },
    { command: "codex --model gpt-5.5" },
  ]);
  assert.equal(resolved.resolution_source, "role_default_profile");
  assert.equal(resolved.fallback_index, 0);
  assert.equal(resolved.candidate_count, 2);
});

test("resolveToolCommand returns ordered candidates with startup messages", () => {
  const firstCommand = "codex --model gpt-5.6-luna";
  const secondCommand = "claude --model sonnet";
  const config = {
    version: 2,
    roles: { reviewer: "reviewer_default" },
    profiles: {
      reviewer_default: {
        strategy: "ordered",
        candidates: [
          {
            command: firstCommand,
            startup_message: "Follow the review workflow.",
            thurbox_agent_key: "codex",
          },
          {
            command: secondCommand,
            startup_message: "Use the fallback review workflow.",
          },
        ],
      },
    },
  };

  const selected = resolveToolCommand({
    role: "reviewer",
    inspectCommand: availableInspection,
    config,
  });
  assert.equal(selected.resolved_tool_cmd, firstCommand);
  assert.equal(selected.startup_message, "Follow the review workflow.");
  assert.equal(selected.thurbox_agent_key, "codex");

  const listed = resolveToolCommand({
    role: "reviewer",
    showList: true,
    inspectCommand: availableInspection,
    config,
  });
  assert.deepEqual(listed.tool_candidates, [
    {
      command: firstCommand,
      startup_message: "Follow the review workflow.",
      thurbox_agent_key: "codex",
    },
    {
      command: secondCommand,
      startup_message: "Use the fallback review workflow.",
    },
  ]);
  assert.equal("startup_message" in listed, false);
});

test("resolveToolCommand keeps legacy candidates free of startup_message", () => {
  const resolved = resolveToolCommand({
    profile: "reviewer_default",
    inspectCommand: availableInspection,
    config: {
      version: 1,
      roles: {},
      profiles: {
        reviewer_default: {
          strategy: "ordered",
          candidates: ["codex --model gpt-5.5"],
        },
      },
    },
  });

  assert.equal("startup_message" in resolved, false);
});

test("resolveToolCommand rejects an empty configured startup_message", () => {
  assert.throws(
    () =>
      resolveToolCommand({
        profile: "reviewer_default",
        inspectCommand: availableInspection,
        config: {
          version: 2,
          roles: {},
          profiles: {
            reviewer_default: {
              strategy: "ordered",
              candidates: [
                {
                  command: "codex --model gpt-5.6-luna",
                  startup_message: "",
                },
              ],
            },
          },
        },
      }),
    /startup_message must be non-empty when set/
  );
});

test("resolveToolCommand rejects an empty configured Thurbox agent key", () => {
  assert.throws(
    () =>
      resolveToolCommand({
        profile: "reviewer_default",
        inspectCommand: availableInspection,
        config: {
          version: 2,
          roles: {},
          profiles: {
            reviewer_default: {
              strategy: "ordered",
              candidates: [
                {
                  command: "codex --model gpt-5.6-luna",
                  thurbox_agent_key: " ",
                },
              ],
            },
          },
        },
      }),
    /thurbox_agent_key must be non-empty when set/
  );
});

test("explainer role prefers the configured agy command", () => {
  const config = loadToolConfig(
    path.resolve(__dirname, "../../../config/tool-profiles.toml"),
    []
  );
  const resolved = resolveToolCommand({
    role: "explainer",
    showList: true,
    inspectCommand: availableInspection,
    config,
  });

  assert.equal(resolved.tool_profile, "explainer_default");
  assert.equal(resolved.resolved_tool_cmd, "agy --model gemini-3.6-flash-high");
  assert.equal(resolved.resolution_source, "role_default_profile");
  assert.equal(
    resolved.tool_candidates[0].command,
    "agy --model gemini-3.6-flash-high"
  );
});

test("design pruner prefers agy with GPT-5.6 Sol medium as fallback", () => {
  const config = loadToolConfig(
    path.resolve(__dirname, "../../../config/tool-profiles.toml"),
    []
  );
  const resolved = resolveToolCommand({
    role: "design_pruner",
    showList: true,
    inspectCommand: availableInspection,
    config,
  });

  assert.equal(resolved.tool_profile, "design_pruner_default");
  assert.equal(resolved.resolved_tool_cmd, "agy");
  assert.equal(resolved.tool_candidates[0].command, "agy");
  assert.match(resolved.tool_candidates[1].command, /codex --model gpt-5\.6-sol -c model_reasoning_effort=medium/);
});

test("resolveToolCommand prefers inherited command over role default profile", () => {
  const resolved = resolveToolCommand({
    role: "planner",
    inheritCommand: "claude --model sonnet --permission-mode acceptEdits",
    inspectCommand: availableInspection,
    config: {
      version: 1,
      roles: { planner: "planner_default" },
      profiles: {
        planner_default: {
          strategy: "ordered",
          candidates: ["codex --model gpt-5.4"],
        },
      },
    },
  });

  assert.deepEqual(resolved, {
    tool_profile: "inherited",
    resolved_tool_cmd: "claude --model sonnet --permission-mode acceptEdits",
    resolution_source: "inherit_command",
    fallback_index: 0,
    candidate_count: 1,
  });
});

test("resolveToolCommand prefers explicit profile over inherited command", () => {
  const resolved = resolveToolCommand({
    role: "planner",
    profile: "planner_alt",
    inheritCommand: "claude --model sonnet --permission-mode acceptEdits",
    inspectCommand: availableInspection,
    config: {
      version: 1,
      roles: { planner: "planner_default" },
      profiles: {
        planner_default: {
          strategy: "ordered",
          candidates: ["codex --model gpt-5.4"],
        },
        planner_alt: {
          strategy: "ordered",
          candidates: ["codex --model gpt-5.5"],
        },
      },
    },
  });

  assert.equal(resolved.tool_profile, "planner_alt");
  assert.equal(resolved.resolved_tool_cmd, "codex --model gpt-5.5");
  assert.equal(resolved.resolution_source, "explicit_profile");
});

test("resolveToolCommand returns candidates in retry order", () => {
  const firstCommand = "codex --model gpt-5.4";
  const secondCommand = "claude --model sonnet";
  const resolved = resolveToolCommand({
    profile: "reviewer_default",
    showList: true,
    inspectCommand: availableInspection,
    config: {
      version: 1,
      roles: {},
      profiles: {
        reviewer_default: {
          strategy: "ordered",
          candidates: [
            {
              command: firstCommand,
              startup_message: "Initialize the primary reviewer.",
            },
            {
              command: secondCommand,
              startup_message: "Initialize the fallback reviewer.",
            },
          ],
        },
      },
    },
  });

  assert.equal(resolved.resolved_tool_cmd, firstCommand);
  assert.deepEqual(resolved.tool_candidates, [
    {
      command: firstCommand,
      startup_message: "Initialize the primary reviewer.",
    },
    {
      command: secondCommand,
      startup_message: "Initialize the fallback reviewer.",
    },
  ]);
  assert.equal(resolved.fallback_index, 0);
});

test("resolveToolCommand skips missing executables and reports them", () => {
  const missingCmd = "missing-tool --model unavailable";
  const usableCmd = "available-tool --model ready";
  const inspectCommand = (toolCmd) =>
    toolCmd === missingCmd
      ? {
          availability: "unavailable",
          tool_cmd: toolCmd,
          executable: "missing-tool",
          reason: "not_found_on_path",
        }
      : availableInspection(toolCmd);
  const resolved = resolveToolCommand({
    profile: "reviewer_default",
    showList: true,
    inspectCommand,
    config: {
      version: 1,
      roles: {},
      profiles: {
        reviewer_default: {
          strategy: "ordered",
          candidates: [missingCmd, usableCmd],
        },
      },
    },
  });

  assert.equal(resolved.resolved_tool_cmd, usableCmd);
  assert.deepEqual(resolved.tool_candidates, [{ command: usableCmd }]);
  assert.equal(resolved.fallback_index, 1);
  assert.deepEqual(resolved.unavailable_tool_cmds, [
    {
      tool_cmd: missingCmd,
      executable: "missing-tool",
      reason: "not_found_on_path",
      candidate_index: 0,
    },
  ]);
});

test("resolveToolCommand fails clearly when every candidate is unavailable", () => {
  assert.throws(
    () =>
      resolveToolCommand({
        profile: "reviewer_default",
        inspectCommand: (toolCmd) => ({
          availability: "unavailable",
          tool_cmd: toolCmd,
          executable: "missing-tool",
          reason: "not_found_on_path",
        }),
        config: {
          version: 1,
          roles: {},
          profiles: {
            reviewer_default: {
              strategy: "ordered",
              candidates: ["missing-tool --model unavailable"],
            },
          },
        },
      }),
    /no usable tool commands for profile reviewer_default: missing-tool: not_found_on_path/
  );
});

test("resolveToolCommand keeps an explicit command missing only from dispatcher PATH", () => {
  const resolved = resolveToolCommand({
    command: "agent --model target-only",
    showList: true,
    inspectionOptions: { pathEnv: "", cwd: process.cwd() },
    config: { version: 1, roles: {}, profiles: {} },
  });

  assert.equal(resolved.resolved_tool_cmd, "agent --model target-only");
  assert.deepEqual(resolved.tool_candidates, [
    { command: "agent --model target-only" },
  ]);
  assert.deepEqual(resolved.unverified_tool_cmds, [
    {
      tool_cmd: "agent --model target-only",
      executable: "agent",
      reason: "not_found_on_dispatcher_path",
      candidate_index: 0,
    },
  ]);
});

test("resolveToolCommand defaults an omitted profile strategy to ordered", () => {
  const resolved = resolveToolCommand({
    role: "coder",
    inspectCommand: availableInspection,
    config: {
      version: 2,
      roles: { coder: "coder_local" },
      profiles: {
        coder_local: {
          candidates: ["claude --model sonnet --permission-mode acceptEdits"],
        },
      },
    },
  });

  assert.equal(resolved.tool_profile, "coder_local");
  assert.equal(
    resolved.resolved_tool_cmd,
    "claude --model sonnet --permission-mode acceptEdits"
  );
});

test("resolveToolCommand expands template candidates before inspection", () => {
  const resolved = resolveToolCommand({
    profile: "coder_default",
    showList: true,
    inspectCommand: availableInspection,
    config: {
      version: 2,
      roles: {},
      templates: { claude_edits: "--permission-mode acceptEdits" },
      profiles: {
        coder_default: {
          candidates: [
            {
              command: "claude --model sonnet ${templates.claude_edits}",
              startup_message: "Start the coding workflow.",
            },
          ],
        },
      },
    },
  });

  assert.equal(
    resolved.resolved_tool_cmd,
    "claude --model sonnet --permission-mode acceptEdits"
  );
  assert.deepEqual(resolved.tool_candidates, [
    {
      command: "claude --model sonnet --permission-mode acceptEdits",
      startup_message: "Start the coding workflow.",
    },
  ]);
});

test("resolveToolCommand still rejects an unsupported explicit strategy", () => {
  assert.throws(
    () =>
      resolveToolCommand({
        profile: "coder_local",
        inspectCommand: availableInspection,
        config: {
          version: 2,
          roles: {},
          profiles: {
            coder_local: {
              strategy: "random",
              candidates: ["claude --model sonnet --permission-mode acceptEdits"],
            },
          },
        },
      }),
    /unsupported tool profile strategy: random/
  );
});

test("resolveToolCommand filters a missing relative command in the target workdir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-command-"));
  const workdir = path.join(tmpDir, "workspace");
  const binDir = path.join(workdir, "bin");
  const usableCmd = "./bin/available-tool";
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "available-tool"), "#!/bin/sh\n", "utf8");
  fs.chmodSync(path.join(binDir, "available-tool"), 0o755);

  const resolved = resolveToolCommand({
    profile: "reviewer_default",
    showList: true,
    inspectionOptions: { cwd: workdir, cwdTrusted: true, pathEnv: "" },
    config: {
      version: 1,
      roles: {},
      profiles: {
        reviewer_default: {
          strategy: "ordered",
          candidates: ["./bin/missing-tool", usableCmd],
        },
      },
    },
  });

  assert.equal(resolved.resolved_tool_cmd, usableCmd);
  assert.deepEqual(resolved.tool_candidates, [{ command: usableCmd }]);
  assert.deepEqual(resolved.unavailable_tool_cmds, [
    {
      tool_cmd: "./bin/missing-tool",
      executable: "./bin/missing-tool",
      reason: "not_found_at_path",
      candidate_index: 0,
    },
  ]);
});
