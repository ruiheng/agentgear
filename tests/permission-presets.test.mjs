import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addPermissionPreset,
  addPermissionPresets,
  listPermissionPresets,
  runPermissionPresetCommand,
  validatePreset
} from "../cli/lib/permission-presets.mjs";
import { permissionAdapters } from "../providers/permission-adapters/index.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(name) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `agentgear-${name}-`));
  const project = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { temporary, project, environment: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") } };
}

function initializeWorkflowPermissions(current) {
  return childProcess.spawnSync(process.execPath, [
    path.join(rootDir, "bin", "agentgear.mjs"),
    "permissions", "init", "--scope", "project", "--project", current.project
  ], { encoding: "utf8", env: { ...current.environment, PATH: "" } });
}

function removeGitDiffWorkflowClaims(project) {
  const claimFile = path.join(project, ".claude", ".agentgear-workflow-claims.json");
  const claims = JSON.parse(fs.readFileSync(claimFile, "utf8"));
  claims.permissions = claims.permissions.filter(permission => !["Bash(git diff)", "Bash(git diff *)"].includes(permission));
  fs.writeFileSync(claimFile, `${JSON.stringify(claims, null, 2)}\n`);
}

test("development permission presets are independently cataloged", () => {
  const names = listPermissionPresets().map(preset => preset.name);
  assert.deepEqual(names, [
    "go", "haskell", "node", "javascript", "typescript", "frontend",
    "vue", "react", "svelte", "python", "rust"
  ]);
});

test("adding composable presets writes independent native harness rules", () => {
  const current = fixture("preset-add");
  try {
    const source = JSON.parse(fs.readFileSync(path.join(rootDir, "catalog", "permission-presets", "go.json"), "utf8"));
    const claudeFile = path.join(current.project, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, `${JSON.stringify({ permissions: { allow: ["Bash(user-tool *)"] } })}\n`);

    const result = addPermissionPreset(source, {
      project: current.project,
      scope: "project",
      env: current.environment
    });

    const claude = JSON.parse(fs.readFileSync(result.paths.claude, "utf8"));
    assert.equal(claude.permissions.allow.includes("Bash(user-tool *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(gofmt *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(go test *)"), true);
    assert.match(fs.readFileSync(result.paths.codex, "utf8"), /pattern = \["go", "test"\]/);
    assert.match(fs.readFileSync(result.paths.gemini, "utf8"), /commandPrefix = \["go", "test"\]/);
    assert.equal(path.basename(result.paths.codex), "agentgear-preset-go.rules");
    assert.equal(path.basename(result.paths.gemini), "agentgear-preset-go.toml");
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("project presets reject symlinked harness configuration directories", { skip: process.platform === "win32" }, () => {
  const preset = {
    name: "safe-checks",
    description: "Safe checks.",
    rules: [{ command: ["safe-check"], justification: "Run safe checks." }]
  };
  for (const [target, directory] of [["claude", ".claude"], ["codex", ".codex"], ["gemini", ".gemini"]]) {
    const current = fixture(`preset-${target}-symlink`);
    try {
      const external = path.join(current.temporary, "external");
      fs.mkdirSync(external, { recursive: true });
      fs.symlinkSync(external, path.join(current.project, directory), "dir");
      assert.throws(() => addPermissionPreset(preset, {
        project: current.project,
        env: current.environment,
        targets: [target]
      }), /refusing symlinked or non-directory project permission path/);
      assert.deepEqual(fs.readdirSync(external), []);
    } finally {
      fs.rmSync(current.temporary, { recursive: true, force: true });
    }
  }
});

test("multi-preset API rolls back earlier writes when a later render fails", () => {
  const current = fixture("preset-batch-rollback");
  const target = "test-transaction";
  permissionAdapters.set(target, {
    name: target,
    resolve({ project, presetName }) {
      const outputPath = path.join(project, ".test-permissions", `${presetName}.json`);
      return { files: { output: outputPath }, outputPath };
    },
    render({ preset, files }) {
      if (preset.name === "second-preset") throw new Error("injected second preset failure");
      return [{ path: files.output, source: `${preset.name}\n` }];
    }
  });
  try {
    const first = {
      name: "first-preset",
      description: "First preset.",
      rules: [{ command: ["first-check"], justification: "Run first checks." }]
    };
    const second = {
      name: "second-preset",
      description: "Second preset.",
      rules: [{ command: ["second-check"], justification: "Run second checks." }]
    };
    assert.throws(() => addPermissionPresets([first, second], {
      project: current.project,
      env: current.environment,
      targets: [target]
    }), /injected second preset failure/);
    assert.equal(fs.existsSync(path.join(current.project, ".test-permissions", "first-preset.json")), false);
    assert.equal(fs.existsSync(path.join(current.project, ".test-permissions", "second-preset.json")), false);
  } finally {
    permissionAdapters.delete(target);
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("multi-preset CLI preflights every path and prints no partial success", { skip: process.platform === "win32" }, () => {
  const current = fixture("preset-batch-preflight");
  try {
    const rulesDirectory = path.join(current.project, ".codex", "rules");
    const external = path.join(current.temporary, "external.rules");
    fs.mkdirSync(rulesDirectory, { recursive: true });
    fs.writeFileSync(external, "external\n");
    fs.symlinkSync(external, path.join(rulesDirectory, "agentgear-preset-typescript.rules"));
    const result = childProcess.spawnSync(process.execPath, [
      path.join(rootDir, "bin", "agentgear.mjs"),
      "permissions", "preset", "add", "node", "typescript",
      "--project", current.project, "--target", "codex"
    ], { encoding: "utf8", env: current.environment });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Added permission preset/);
    assert.equal(fs.existsSync(path.join(rulesDirectory, "agentgear-preset-node.rules")), false);
    assert.equal(fs.readFileSync(external, "utf8"), "external\n");
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("a customized preset replaces its prior Claude-owned rules and preserves user rules", () => {
  const current = fixture("preset-customize");
  try {
    const first = {
      name: "local-web",
      description: "Local web checks.",
      rules: [
        { command: ["web-check", "test"], justification: "Run checks." },
        { command: ["web-check", "lint"], justification: "Run lint." }
      ]
    };
    const second = {
      ...first,
      rules: [{ command: ["web-check", "test"], justification: "Run checks." }]
    };
    addPermissionPreset(first, { project: current.project, env: current.environment, targets: ["claude"] });
    const settingsFile = path.join(current.project, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.permissions.allow.push("Bash(user-tool *)");
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

    addPermissionPreset(second, { project: current.project, env: current.environment, targets: ["claude"] });
    const updated = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(updated.permissions.allow.includes("Bash(web-check lint *)"), false);
    assert.equal(updated.permissions.allow.includes("Bash(web-check test *)"), true);
    assert.equal(updated.permissions.allow.includes("Bash(user-tool *)"), true);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("a preset never claims or removes an identical pre-existing user permission", () => {
  const current = fixture("preset-preexisting-rule");
  try {
    const settingsFile = path.join(current.project, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({
      permissions: { allow: ["Bash(shared-check *)"] }
    }, null, 2)}\n`);
    const first = {
      name: "shared-stack",
      description: "Shared checks.",
      rules: [{ command: ["shared-check"], justification: "Run shared checks." }]
    };
    addPermissionPreset(first, { project: current.project, env: current.environment, targets: ["claude"] });
    addPermissionPreset({
      ...first,
      rules: [{ command: ["replacement-check"], justification: "Run replacement checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.permissions.allow.includes("Bash(shared-check *)"), true);
    assert.equal(settings.permissions.allow.includes("Bash(shared-check)"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("shared Claude permissions remain while another preset still owns them", () => {
  const current = fixture("preset-shared-rule");
  try {
    const sharedRule = { command: ["shared-check"], justification: "Run shared checks." };
    const first = { name: "first-stack", description: "First stack.", rules: [sharedRule] };
    const second = { name: "second-stack", description: "Second stack.", rules: [sharedRule] };
    addPermissionPreset(first, { project: current.project, env: current.environment, targets: ["claude"] });
    addPermissionPreset(second, { project: current.project, env: current.environment, targets: ["claude"] });
    addPermissionPreset({
      ...first,
      rules: [{ command: ["first-only"], justification: "Run first-only checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });

    const settings = JSON.parse(fs.readFileSync(path.join(current.project, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.allow.includes("Bash(shared-check *)"), true);

    addPermissionPreset({
      ...second,
      rules: [{ command: ["second-only"], justification: "Run second-only checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });
    const finalSettings = JSON.parse(fs.readFileSync(path.join(current.project, ".claude", "settings.json"), "utf8"));
    assert.equal(finalSettings.permissions.allow.includes("Bash(shared-check *)"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("preset replacement preserves permissions claimed by workflow initialization", () => {
  const current = fixture("preset-workflow-claim");
  try {
    const preset = {
      name: "git-checks",
      description: "Git checks.",
      rules: [{ command: ["git", "diff"], justification: "Inspect Git changes." }]
    };
    addPermissionPreset(preset, { project: current.project, env: current.environment, targets: ["claude"] });
    const initialized = initializeWorkflowPermissions(current);
    assert.equal(initialized.status, 0, initialized.stderr);

    addPermissionPreset({
      ...preset,
      rules: [{ command: ["replacement-check"], justification: "Run replacement checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });
    const settings = JSON.parse(fs.readFileSync(path.join(current.project, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.allow.includes("Bash(git diff)"), true);
    assert.equal(settings.permissions.allow.includes("Bash(git diff *)"), true);
    const workflowClaims = JSON.parse(fs.readFileSync(
      path.join(current.project, ".claude", ".agentgear-workflow-claims.json"),
      "utf8"
    ));
    assert.equal(workflowClaims.permissions.includes("Bash(git diff *)"), true);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("workflow-introduced permission is removed after its last producer claim exits", () => {
  const current = fixture("preset-workflow-provenance");
  try {
    const initialized = initializeWorkflowPermissions(current);
    assert.equal(initialized.status, 0, initialized.stderr);
    const registryFile = path.join(current.project, ".claude", ".agentgear-permission-presets.json");
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(registry.introduced_permissions.includes("Bash(git diff *)"), true);
    const preset = {
      name: "git-provenance",
      description: "Git provenance checks.",
      rules: [{ command: ["git", "diff"], justification: "Inspect Git changes." }]
    };
    addPermissionPreset(preset, { project: current.project, env: current.environment, targets: ["claude"] });
    removeGitDiffWorkflowClaims(current.project);
    addPermissionPreset({
      ...preset,
      rules: [{ command: ["replacement-check"], justification: "Run replacement checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });
    const settings = JSON.parse(fs.readFileSync(path.join(current.project, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.allow.includes("Bash(git diff)"), false);
    assert.equal(settings.permissions.allow.includes("Bash(git diff *)"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("user permission survives after workflow and preset claims both exit", () => {
  const current = fixture("preset-workflow-user-provenance");
  try {
    const settingsFile = path.join(current.project, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({
      permissions: { allow: ["Bash(git diff)", "Bash(git diff *)"] }
    }, null, 2)}\n`);
    const initialized = initializeWorkflowPermissions(current);
    assert.equal(initialized.status, 0, initialized.stderr);
    const registry = JSON.parse(fs.readFileSync(
      path.join(current.project, ".claude", ".agentgear-permission-presets.json"),
      "utf8"
    ));
    assert.equal(registry.introduced_permissions.includes("Bash(git diff *)"), false);
    const preset = {
      name: "user-git-provenance",
      description: "User Git provenance checks.",
      rules: [{ command: ["git", "diff"], justification: "Inspect Git changes." }]
    };
    addPermissionPreset(preset, { project: current.project, env: current.environment, targets: ["claude"] });
    removeGitDiffWorkflowClaims(current.project);
    addPermissionPreset({
      ...preset,
      rules: [{ command: ["replacement-check"], justification: "Run replacement checks." }]
    }, { project: current.project, env: current.environment, targets: ["claude"] });
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.permissions.allow.includes("Bash(git diff)"), true);
    assert.equal(settings.permissions.allow.includes("Bash(git diff *)"), true);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("preset descriptions reject every Unicode control character before rendering", () => {
  for (const control of ["\u0000", "\t", "\n", "\r", "\u001b", "\u007f", "\u0085"]) {
    assert.throws(() => validatePreset({
      name: "controlled-description",
      description: `Looks harmless${control}injected content`,
      rules: [{ command: ["safe-check"], justification: "Run safe checks." }]
    }), /description must be a single line without control characters/);
  }
});

test("agy adapter writes user-scoped command grants without duplicating preset logic", () => {
  const current = fixture("preset-agy");
  try {
    current.environment.AGENTGEAR_AGY_HOME = path.join(current.temporary, "agy-home");
    const preset = {
      name: "go-checks",
      description: "Go checks.",
      rules: [
        { command: ["gofmt"], justification: "Format Go source." },
        { command: ["go", "test"], justification: "Run Go tests." }
      ]
    };
    assert.throws(
      () => addPermissionPreset(preset, { project: current.project, env: current.environment, targets: ["agy"] }),
      /user-scoped/
    );
    const result = addPermissionPreset(preset, {
      scope: "user",
      project: current.project,
      env: current.environment,
      targets: ["agy"]
    });
    const settings = JSON.parse(fs.readFileSync(result.paths.agy, "utf8"));
    assert.deepEqual(settings.permissions.allow, ["command(gofmt)", "command(go test)"]);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("every built-in preset passes through every permission adapter", () => {
  const current = fixture("preset-matrix");
  try {
    current.environment.AGENTGEAR_AGY_HOME = path.join(current.temporary, "agy-home");
    for (const { name } of listPermissionPresets()) {
      const preset = JSON.parse(fs.readFileSync(
        path.join(rootDir, "catalog", "permission-presets", `${name}.json`),
        "utf8"
      ));
      const projectResult = addPermissionPreset(preset, {
        project: current.project,
        env: current.environment,
        targets: ["claude", "codex", "gemini"]
      });
      assert.deepEqual(Object.keys(projectResult.paths), ["claude", "codex", "gemini"]);
      const agyResult = addPermissionPreset(preset, {
        scope: "user",
        project: current.project,
        env: current.environment,
        targets: ["agy"]
      });
      assert.equal(fs.existsSync(agyResult.paths.agy), true);
    }
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("preset show copies editable JSON and the CLI accepts multiple preset names", () => {
  const current = fixture("preset-cli");
  try {
    const output = path.join(current.temporary, "vue-custom.json");
    runPermissionPresetCommand(["show", "vue", "--output", output]);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).name, "vue");

    const result = childProcess.spawnSync(process.execPath, [
      path.join(rootDir, "bin", "agentgear.mjs"),
      "permissions", "preset", "add", "node", "typescript", "frontend", "vue",
      "--scope", "project", "--project", current.project, "--target", "codex,gemini"
    ], { encoding: "utf8", env: current.environment });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["node", "typescript", "frontend", "vue"]) {
      assert.equal(fs.existsSync(path.join(current.project, ".codex", "rules", `agentgear-preset-${name}.rules`)), true);
      assert.equal(fs.existsSync(path.join(current.project, ".gemini", "policies", `agentgear-preset-${name}.toml`)), true);
    }
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});
