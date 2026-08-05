import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../cli/ai-skills.mjs";
import { main as configurePermissions } from "../skills/agent-deck-workflow/scripts/agent-deck-workflow-init-permissions.mjs";

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
    action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("workflow permissions use the stable launcher and never an old source path", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "codex"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => configurePermissions([project]));
    const generated = [
      path.join(project, ".claude", "settings.json"),
      path.join(project, ".codex", "rules", "agent-deck-workflow.rules"),
      path.join(project, ".gemini", "policies", "agent-deck-workflow.toml")
    ].map(filePath => fs.readFileSync(filePath, "utf8"));
    for (const source of generated) {
      assert.match(source, /ai-skills/);
      assert.match(source, /agent-deck-workflow/);
      assert.doesNotMatch(source, /\.config[\\/]ai-agent|\/home\/ruiheng\/config_files/);
      assert.doesNotMatch(source, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const claude = JSON.parse(generated[0]);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/ai-skills run agent-deck-workflow *)"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions grant only validated scoped Waypost CLI access", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-permissions-test-"));
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
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "codex"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => configurePermissions([project]));

    const expectedRead = `Bash(${waypost} --state-dir ${stateDir} read)`;
    const expectedReadWildcard = `${expectedRead.slice(0, -1)} *)`;
    const claude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow.includes(expectedRead), true);
    assert.equal(claude.permissions.allow.includes(expectedReadWildcard), true);
    assert.equal(claude.permissions.allow.includes("Bash(waypost)"), false);
    assert.equal(claude.permissions.allow.includes("Bash(waypost *)"), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, ".claude", ".agent-deck-workflow-waypost-cli.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.rules.length, 4);

    const codex = fs.readFileSync(path.join(project, ".codex", "rules", "agent-deck-workflow.rules"), "utf8");
    assert.match(codex, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(codex, /pattern = \["waypost"/);

    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.match(gemini, /mcpName = "waypost"/);
    assert.match(gemini, new RegExp(escapeRegex(waypost)));

    const userPermission = "Bash(/opt/custom-waypost --state-dir /tmp/custom-state read)";
    claude.permissions.allow.push(userPermission);
    fs.writeFileSync(claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);
    withEnvironment({ ...environment, PATH: "" }, () => configurePermissions([project]));

    const updatedClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(updatedClaude.permissions.allow.includes(expectedRead), false);
    assert.equal(updatedClaude.permissions.allow.includes(userPermission), true);
    const updatedGemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.doesNotMatch(updatedGemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject project-local Waypost commands", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-reject-test-"));
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
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "codex"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => configurePermissions([project]));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject a relative Waypost state directory", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-state-test-"));
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
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "codex"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => configurePermissions([project]));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject Waypost found through a relative PATH entry", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-relative-command-test-"));
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
    withEnvironment(environment, () => configurePermissions([project]));

    const claude = fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions reject a Waypost command inside a symlinked project", { skip: process.platform === "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-symlink-project-test-"));
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
    withEnvironment(environment, () => configurePermissions([projectLink]));

    const claude = fs.readFileSync(path.join(physicalProject, ".claude", "settings.json"), "utf8");
    const gemini = fs.readFileSync(path.join(physicalProject, ".gemini", "policies", "agent-deck-workflow.toml"), "utf8");
    assert.doesNotMatch(claude, new RegExp(escapeRegex(waypost)));
    assert.doesNotMatch(gemini, /mcpName = "waypost"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions migrate a verified legacy v1 Waypost manifest", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-waypost-v1-manifest-test-"));
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
  const manifestFile = path.join(claudeDir, ".agent-deck-workflow-waypost-cli.json");

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ permissions: { allow: [legacyPermission, userPermission] } }, null, 2)}\n`);
    fs.writeFileSync(manifestFile, `${JSON.stringify({ version: 1, permissions: [legacyPermission] })}\n`);
    withEnvironment(environment, () => configurePermissions([project]));

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.permissions.allow.includes(legacyPermission), false);
    assert.equal(settings.permissions.allow.includes(userPermission), true);
    assert.equal(settings.permissions.allow.includes(`Bash(${waypost} --state-dir ${stateDir} read)`), true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.version, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
