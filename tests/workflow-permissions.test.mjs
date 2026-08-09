import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../cli/agentgear.mjs";
import {
  checkPermissions,
  initializePermissions,
  permissionPaths,
  workflowWaypostMcpTools
} from "../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeWaypostExecutable(directory, name = "waypost") {
  const executable = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const supported = (args[0] === "mcp" && args[1] === "--help") ||
  (args[0] === "--state-dir" && (args[2] === "read" || args[2] === "list") && args[3] === "--help");
process.exit(supported ? 0 : 1);
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function withEnvironment(environment, action) {
  const original = {};
  for (const [key, value] of Object.entries(environment)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("workflow permissions use the stable launcher and never an old source path", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "general"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));
    const generated = [
      path.join(project, ".claude", "settings.json"),
      path.join(project, ".codex", "rules", "agentgear-workflow.rules"),
      path.join(project, ".gemini", "policies", "agentgear-workflow.toml")
    ].map(filePath => fs.readFileSync(filePath, "utf8"));
    for (const source of generated) {
      assert.match(source, /agentgear/);
      assert.match(source, /multi-agent-protocol/);
      assert.doesNotMatch(source, /\.config[\\/]ai-agent|\/home\/ruiheng\/config_files/);
      assert.doesNotMatch(source, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const claude = JSON.parse(generated[0]);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear run multi-agent-protocol *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear run multi-agent-protocol *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear resolve-tool-command *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear resolve-tool-command *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear install *)"), false);
    assert.match(generated[1], /pattern = \["agentgear", "resolve-tool-command"\]/);
    assert.match(generated[2], /commandPrefix = \["agentgear", "resolve-tool-command"\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions add explicit Waypost MCP approvals for Claude and Codex", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-mcp-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const stateDir = path.join(temporary, "waypost-state");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: stateDir,
    PATH: bin
  };
  const codexConfig = path.join(home, ".codex", "config.toml");
  const projectCodexConfig = path.join(project, ".codex", "config.toml");

  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n[mcp_servers.waypost.tools.user_owned]\napproval_mode = "deny"\n`);
    fs.mkdirSync(project, { recursive: true });

    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const claude = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8"));
    for (const tool of workflowWaypostMcpTools) {
      assert.equal(claude.permissions.allow.includes(`mcp__waypost__${tool}`), true, `Claude permits ${tool}`);
    }

    const codex = fs.readFileSync(projectCodexConfig, "utf8");
    assert.match(fs.readFileSync(codexConfig, "utf8"), /\[mcp_servers\.waypost\.tools\.user_owned\]\napproval_mode = "deny"/);
    for (const tool of workflowWaypostMcpTools) {
      const section = `[mcp_servers.waypost.tools.${tool}]\napproval_mode = "approve"`;
      assert.equal(codex.split(section).length - 1, 1, `Codex permits ${tool} exactly once`);
    }
    const codexOwnership = JSON.parse(fs.readFileSync(
      path.join(project, ".codex", ".agentgear-workflow-permissions.json"),
      "utf8"
    ));
    assert.deepEqual(codexOwnership, { version: 1, tools: workflowWaypostMcpTools });
    const checked = withEnvironment(environment, () => checkPermissions({ scope: "project", project }));
    assert.equal(checked.ok, true, checked.issues.join("\n"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("user-scoped permission init and check cover all harnesses", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-user-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(paths.codexConfig, `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n`);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));
    const configured = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(configured.ok, true, configured.issues.join("\n"));
    assert.equal(configured.paths.claudeSettings, path.join(home, ".claude", "settings.json"));
    assert.equal(configured.paths.geminiPolicy, path.join(home, ".gemini", "policies", "agentgear-workflow.toml"));

    const claude = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
    claude.permissions.allow = claude.permissions.allow.filter(permission => permission !== "mcp__waypost__session_resolve");
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);
    const stale = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(stale.ok, false);
    assert.equal(stale.issues.some(issue => /Claude settings are missing/.test(issue)), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions do not create Codex approvals without a configured Waypost MCP", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-mcp-missing-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  const codexConfig = path.join(home, ".codex", "config.toml");
  const projectCodexConfig = path.join(project, ".codex", "config.toml");

  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, "model = \"gpt-5\"\n");
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const codex = fs.readFileSync(codexConfig, "utf8");
    for (const tool of workflowWaypostMcpTools) {
      assert.doesNotMatch(codex, new RegExp(`mcp_servers\\.waypost\\.tools\\.${tool}`));
    }
    assert.equal(fs.existsSync(projectCodexConfig), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions revoke Agentgear-owned Codex approvals when Waypost loses trust", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-codex-revoke-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(
      paths.codexConfig,
      `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n[mcp_servers.waypost.tools.user_owned]\napproval_mode = "deny"\n`
    );
    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    const stale = withEnvironment({ ...environment, PATH: "" }, () =>
      checkPermissions({ scope: "user", project }));
    assert.equal(stale.issues.some(issue => /retains Agentgear-owned Waypost MCP approvals/.test(issue)), true);

    withEnvironment({ ...environment, PATH: "" }, () => initializePermissions({ scope: "user", project }));

    const codex = fs.readFileSync(paths.codexConfig, "utf8");
    assert.match(codex, /mcp_servers\.waypost\.tools\.user_owned/);
    for (const tool of workflowWaypostMcpTools) {
      assert.doesNotMatch(codex, new RegExp(`mcp_servers\\.waypost\\.tools\\.${tool}`));
    }
    assert.equal(fs.existsSync(paths.codexOwnership), false);
    const reconciled = withEnvironment({ ...environment, PATH: "" }, () =>
      checkPermissions({ scope: "user", project }));
    assert.equal(reconciled.issues.some(issue => /retains Agentgear-owned Waypost MCP approvals/.test(issue)), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions migrate the legacy Codex approval block into owned boundaries", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-codex-legacy-block-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    const legacySections = workflowWaypostMcpTools
      .map(tool => `[mcp_servers.waypost.tools.${tool}]\napproval_mode = "approve"`)
      .join("\n\n");
    fs.writeFileSync(
      paths.codexConfig,
      `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n# Agentgear multi-agent-protocol Waypost MCP approvals\n${legacySections}\n`
    );

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    const source = fs.readFileSync(paths.codexConfig, "utf8");
    assert.doesNotMatch(source, /# Agentgear multi-agent-protocol Waypost MCP approvals/);
    assert.match(source, /# BEGIN Agentgear Waypost MCP approvals/);
    assert.match(source, /# END Agentgear Waypost MCP approvals/);
    assert.equal(fs.existsSync(paths.codexOwnership), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions refuse to override a user-managed Codex denial", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-codex-deny-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    const original = `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n[mcp_servers.waypost.tools."session_create"] # user-owned\napproval_mode = "deny"\n`;
    fs.writeFileSync(paths.codexConfig, original);

    assert.throws(
      () => withEnvironment(environment, () => initializePermissions({ scope: "user", project })),
      /refusing to override user-managed Codex Waypost approval mode for: session_create/
    );

    assert.equal(fs.readFileSync(paths.codexConfig, "utf8"), original);
    assert.equal(fs.existsSync(paths.claudeSettings), false);
    assert.equal(fs.existsSync(paths.codexRules), false);
    assert.equal(fs.existsSync(paths.codexOwnership), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions grant only validated scoped Waypost CLI access", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const stateDir = path.join(temporary, "waypost-state");
  const waypost = writeWaypostExecutable(bin);
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: stateDir,
    PATH: bin
  };
  const claudeSettings = path.join(project, ".claude", "settings.json");

  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "general"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const expectedRead = `Bash(${waypost} --state-dir ${stateDir} read)`;
    const expectedReadWildcard = `${expectedRead.slice(0, -1)} *)`;
    const claude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow.includes(expectedRead), true);
    assert.equal(claude.permissions.allow.includes(expectedReadWildcard), true);
    assert.equal(claude.permissions.allow.includes("Bash(waypost)"), false);
    assert.equal(claude.permissions.allow.includes("Bash(waypost *)"), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, ".claude", ".agentgear-workflow-permissions.json"), "utf8"));
    assert.equal(manifest.version, 3);
    assert.equal(manifest.rules.length, 4);
    assert.deepEqual(manifest.mcp_permissions, workflowWaypostMcpTools.map(tool => `mcp__waypost__${tool}`));

    const codex = fs.readFileSync(path.join(project, ".codex", "rules", "agentgear-workflow.rules"), "utf8");
    assert.match(codex, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(codex, /pattern = \["waypost"/);

    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.match(gemini, /mcpName = "waypost"/);
    assert.match(gemini, new RegExp(escapeRegex(waypost)));

    const userPermission = "Bash(/opt/custom-waypost --state-dir /tmp/custom-state read)";
    claude.permissions.allow.push(userPermission);
    fs.writeFileSync(claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);
    const manifestFile = path.join(project, ".claude", ".agentgear-workflow-permissions.json");
    const legacyManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    legacyManifest.version = 2;
    delete legacyManifest.mcp_permissions;
    fs.writeFileSync(manifestFile, `${JSON.stringify(legacyManifest)}\n`);
    withEnvironment({ ...environment, PATH: "" }, () => initializePermissions({ scope: "project", project }));

    const updatedClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(updatedClaude.permissions.allow.includes(expectedRead), false);
    assert.equal(updatedClaude.permissions.allow.includes(userPermission), true);
    for (const tool of workflowWaypostMcpTools) {
      assert.equal(updatedClaude.permissions.allow.includes(`mcp__waypost__${tool}`), false, `stale MCP grant ${tool} was removed`);
    }
    assert.equal(fs.existsSync(manifestFile), false);
    const updatedGemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.doesNotMatch(updatedGemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject project-local Waypost commands", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-reject-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const projectBin = path.join(project, "bin");
  const waypost = writeWaypostExecutable(projectBin);
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: projectBin
  };

  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "general"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject a relative Waypost state directory", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-state-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const waypost = writeWaypostExecutable(bin);
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: "relative-state",
    PATH: bin
  };

  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "general"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject Waypost found through a relative PATH entry", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-relative-command-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const relativeBin = "waypost-bin";
  const waypost = writeWaypostExecutable(path.join(temporary, relativeBin));
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: relativeBin
  };
  const originalCwd = process.cwd();

  try {
    fs.mkdirSync(project, { recursive: true });
    process.chdir(temporary);
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject a Waypost command inside a symlinked project", { skip: process.platform === "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-symlink-project-test-"));
  const home = path.join(temporary, "home");
  const physicalProject = path.join(temporary, "physical-project");
  const projectLink = path.join(temporary, "project-link");
  const bin = path.join(physicalProject, "bin");
  const waypost = writeWaypostExecutable(bin);
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };

  try {
    fs.mkdirSync(physicalProject, { recursive: true });
    fs.symlinkSync(physicalProject, projectLink, "dir");
    withEnvironment(environment, () => initializePermissions({ scope: "project", project: projectLink }));

    const claude = fs.readFileSync(path.join(physicalProject, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(physicalProject, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions migrate a verified legacy v1 Waypost manifest", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-v1-manifest-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const stateDir = path.join(temporary, "waypost-state");
  const waypost = writeWaypostExecutable(bin);
  const legacyWaypost = path.join(temporary, "legacy", "waypost");
  const legacyPermission = `Bash(${legacyWaypost} --state-dir ${stateDir} read)`;
  const userPermission = "Bash(/opt/custom-waypost --state-dir /tmp/custom-state read)";
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: stateDir,
    PATH: bin
  };
  const claudeDir = path.join(project, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const legacyManifestFile = path.join(claudeDir, ".agent-deck-workflow-waypost-cli.json");
  const manifestFile = path.join(claudeDir, ".agentgear-workflow-permissions.json");

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ permissions: { allow: [legacyPermission, userPermission] } }, null, 2)}\n`);
    fs.writeFileSync(legacyManifestFile, `${JSON.stringify({ version: 1, permissions: [legacyPermission] })}\n`);
    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.permissions.allow.includes(legacyPermission), false);
    assert.equal(settings.permissions.allow.includes(userPermission), true);
    assert.equal(settings.permissions.allow.includes(`Bash(${waypost} --state-dir ${stateDir} read)`), true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.mcp_permissions, workflowWaypostMcpTools.map(tool => `mcp__waypost__${tool}`));
    assert.equal(fs.existsSync(legacyManifestFile), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions preserve Codex config mode and honor CODEX_HOME", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-codex-home-test-"));
  const home = path.join(temporary, "home");
  const codexHome = path.join(temporary, "custom-codex");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const environment = {
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  const configFile = path.join(codexHome, "config.toml");
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n`);
    fs.chmodSync(configFile, 0o600);
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
    assert.match(fs.readFileSync(configFile, "utf8"), /mcp_servers\.waypost\.tools\.session_create/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions refuse to extend inline Codex Waypost tools", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-inline-tools-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const configFile = path.join(home, ".codex", "config.toml");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost-state"),
    PATH: bin
  };
  try {
    writeWaypostExecutable(bin);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\ntools = {}\n`);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    assert.throws(() => withEnvironment(environment, () => initializePermissions({ scope: "user", project })), /refusing to extend inline Waypost tools/);
    assert.equal(fs.readFileSync(configFile, "utf8"), `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\ntools = {}\n`);
    assert.equal(fs.existsSync(paths.claudeSettings), false);
    assert.equal(fs.existsSync(paths.codexRules), false);
    assert.equal(fs.existsSync(paths.codexOwnership), false);
    assert.equal(fs.existsSync(paths.geminiPolicy), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
