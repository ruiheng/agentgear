import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../cli/agentgear.mjs";
import {
  checkPermissions,
  findMissingWorkflowLauncherApprovals,
  findMissingWaypostCliFailApprovals,
  findRetiredPermissionApprovals,
  initializePermissions,
  permissionPaths,
  workflowWaypostMcpTools
} from "../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";
import { shellCommand } from "../skills/multi-agent-protocol/scripts/waypost-permission-spec.mjs";

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
  (args[0] === "doc" && args[1] === "--help") ||
  (args[0] === "--state-dir" && ["read", "list", "fail", "forward", "wait", "undefer", "group", "address", "renew"].includes(args[2]) && args[3] === "--help");
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

test("shell command permissions preserve whitespace and quotes in token boundaries", () => {
  assert.equal(
    shellCommand(["tool's path", "--check"]),
    "'tool'\\''s path' --check"
  );
});

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
    assert.equal(claude.permissions.allow.includes("Bash(agentgear run tech-design-workflow *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear run tech-design-workflow *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear run intent-framing *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear run intent-framing *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear run review-tech-design *)"), false);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear run review-tech-design *)"), false);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear skill get *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear skill get *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear resolve-tool-command *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/agentgear resolve-tool-command *)"), true);
    assert.equal(claude.permissions.allow.includes("Bash(agentgear install *)"), false);
    assert.match(generated[1], /pattern = \["agentgear", "resolve-tool-command"\]/);
    assert.match(generated[1], /pattern = \["agentgear", "run", "tech-design-workflow"\]/);
    assert.match(generated[1], /pattern = \["agentgear", "run", "intent-framing"\]/);
    assert.doesNotMatch(generated[1], /pattern = \["agentgear", "run", "review-tech-design"\]/);
    assert.match(generated[1], /pattern = \["agentgear", "skill", "get"\]/);
    assert.match(generated[2], /commandPrefix = \["agentgear", "resolve-tool-command"\]/);
    assert.match(generated[2], /commandPrefix = \["agentgear", "run", "tech-design-workflow"\]/);
    assert.match(generated[2], /commandPrefix = \["agentgear", "run", "intent-framing"\]/);
    assert.doesNotMatch(generated[2], /commandPrefix = \["agentgear", "run", "review-tech-design"\]/);
    assert.match(generated[2], /commandPrefix = \["agentgear", "skill", "get"\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions revoke retired Claude send-and-wake grants", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-retired-claude-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  const settingsFile = path.join(project, ".claude", "settings.json");
  const retiredPermissions = [
    "Bash(~/.local/bin/adwf-send-and-wake *)",
    `Bash(${path.join(home, ".local", "bin", "adwf-send-and-wake")} *)`
  ];
  const userPermission = "Bash(/opt/user-owned-tool *)";
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ permissions: { allow: [...retiredPermissions, userPermission] } }, null, 2)}\n`);

    const stale = withEnvironment(environment, () => checkPermissions({ scope: "project", project }));
    assert.equal(stale.issues.some(issue => /retain 2 retired Agentgear permission/.test(issue)), true);

    withEnvironment(environment, () => initializePermissions({ scope: "project", project }));

    const updated = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    for (const permission of retiredPermissions) {
      assert.equal(updated.permissions.allow.includes(permission), false);
    }
    assert.equal(updated.permissions.allow.includes(userPermission), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("retired permission detection only treats Claude allow entries as approvals", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-retired-permission-detection-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  const settingsFile = path.join(home, ".claude", "settings.json");
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({
      note: "adwf-send-and-wake was retired",
      permissions: { allow: ["Bash(/opt/user-owned-tool *)"] }
    }, null, 2)}\n`);

    const clean = findRetiredPermissionApprovals({
      scope: "user",
      project,
      env: environment
    });
    assert.equal(clean.required, false, clean.issues.join("\n"));

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.permissions.allow.push("Bash(~/.local/bin/adwf-send-and-wake *)");
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    const stale = findRetiredPermissionApprovals({
      scope: "user",
      project,
      env: environment
    });
    assert.equal(stale.required, true);
    assert.equal(stale.issues.some(issue => /Claude settings retain an approval/.test(issue)), true);

    settings.permissions.allow = ["mcp__waypost__session_resolve"];
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    const staleResolve = findRetiredPermissionApprovals({
      scope: "user",
      project,
      env: environment
    });
    assert.equal(staleResolve.required, true);
    assert.equal(staleResolve.issues.some(issue => /retired Waypost session_resolve/.test(issue)), true);

    settings.permissions.allow.push("Bash(~/.local/bin/adwf-send-and-wake *)");
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    const mixed = findRetiredPermissionApprovals({
      scope: "user",
      project,
      env: environment
    });
    assert.equal(mixed.issues.some(issue => /retired Waypost session_resolve/.test(issue)), true);
    assert.equal(mixed.issues.some(issue => /retired command adwf-send-and-wake/.test(issue)), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("permission migration detects managed workflow rules missing workflow launchers", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-missing-launcher-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = { HOME: home, PATH: "" };
  const paths = permissionPaths("user", project, environment);
  try {
    fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify({
      permissions: { allow: ["Bash(agentgear run multi-agent-protocol *)"] }
    }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(paths.codexRules), { recursive: true });
    fs.writeFileSync(paths.codexRules, '# Agentgear workflow - generated approval rules\nprefix_rule(\n    pattern = ["agentgear", "run", "multi-agent-protocol"],\n)\n');
    fs.mkdirSync(path.dirname(paths.geminiPolicy), { recursive: true });
    fs.writeFileSync(paths.geminiPolicy, '# Agentgear workflow - generated policy rules\ncommandPrefix = ["agentgear", "run", "multi-agent-protocol"]\n');

    const stale = findMissingWorkflowLauncherApprovals({
      scope: "user",
      project,
      env: environment
    });

    assert.equal(stale.required, true);
    assert.equal(stale.issues.some(issue => /Claude settings are missing/.test(issue)), true);
    assert.equal(stale.issues.some(issue => /Codex rules is missing/.test(issue)), true);
    assert.equal(stale.issues.some(issue => /Gemini policy is missing/.test(issue)), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("permission migration detects every prior launcher form missing skill get and retires review-tech-design grants", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-skill-get-permission-upgrade-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = { HOME: home, PATH: "" };
  const paths = permissionPaths("user", project, environment);
  const absolute = path.join(home, ".local", "bin", "agentgear");
  const forms = ["agentgear", "~/.local/bin/agentgear", absolute];
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify({
      permissions: {
        allow: forms.flatMap(command => [
          `Bash(${command} run multi-agent-protocol *)`,
          `Bash(${command} run tech-design-workflow *)`,
          `Bash(${command} run review-tech-design *)`
        ])
      }
    }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(paths.codexRules), { recursive: true });
    fs.writeFileSync(paths.codexRules, forms.map(command => [
      `prefix_rule(\n    pattern = [${JSON.stringify(command)}, "run", "multi-agent-protocol"],\n)`,
      `prefix_rule(\n    pattern = [${JSON.stringify(command)}, "run", "tech-design-workflow"],\n)`
    ].join("\n")).join("\n"));
    fs.mkdirSync(path.dirname(paths.geminiPolicy), { recursive: true });
    fs.writeFileSync(paths.geminiPolicy, forms.map(command => [
      `commandPrefix = [${JSON.stringify(command)}, "run", "multi-agent-protocol"]`,
      `commandPrefix = [${JSON.stringify(command)}, "run", "tech-design-workflow"]`
    ].join("\n")).join("\n"));

    const stale = findMissingWorkflowLauncherApprovals({ scope: "user", project, env: environment });
    assert.equal(stale.required, true);
    assert.equal(stale.issues.length, 3);
    assert.equal(stale.issues.every(issue => /6 workflow launcher approval/.test(issue)), true);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));
    const claude = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow.includes("Bash(agentgear run intent-framing *)"), true);
    for (const command of forms) {
      assert.equal(claude.permissions.allow.includes(`Bash(${command} skill get *)`), true);
      assert.equal(claude.permissions.allow.includes(`Bash(${command} run review-tech-design *)`), false);
    }
    assert.equal(findMissingWorkflowLauncherApprovals({ scope: "user", project, env: environment }).required, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("permission migration detects managed Waypost CLI rules missing fail", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-waypost-fail-upgrade-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = { HOME: home, PATH: "" };
  const paths = permissionPaths("user", project, environment);
  const command = "/opt/waypost";
  const stateDir = "/opt/waypost-state";
  const permission = `Bash(${command} --state-dir ${stateDir} read)`;
  const manifestFile = path.join(path.dirname(paths.claudeSettings), ".agentgear-workflow-permissions.json");
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify({ permissions: { allow: [permission] } })}\n`);
    fs.writeFileSync(manifestFile, `${JSON.stringify({
      version: 3,
      permissions: [permission],
      mcp_permissions: [],
      rules: [{ command, state_dir: stateDir, action: "read", wildcard: false }]
    })}\n`);
    fs.mkdirSync(path.dirname(paths.codexRules), { recursive: true });
    fs.writeFileSync(paths.codexRules, `# Agentgear workflow - generated approval rules\nprefix_rule(\n    pattern = ["${command}", "--state-dir", "${stateDir}", "read"],\n)\n`);
    fs.mkdirSync(path.dirname(paths.geminiPolicy), { recursive: true });
    fs.writeFileSync(paths.geminiPolicy, `# Agentgear workflow - generated policy rules\ncommandPrefix = ["${command}", "--state-dir", "${stateDir}", "list"]\n`);

    const stale = findMissingWaypostCliFailApprovals({ scope: "user", project, env: environment });
    assert.equal(stale.required, true);
    assert.equal(stale.issues.length, 3);
    assert.equal(stale.issues.every(issue => /missing fail/.test(issue)), true);

    fs.rmSync(manifestFile);
    fs.writeFileSync(paths.codexRules, "# Agentgear workflow - generated approval rules\n");
    fs.writeFileSync(paths.geminiPolicy, "# Agentgear workflow - generated policy rules\n");
    assert.equal(findMissingWaypostCliFailApprovals({ scope: "user", project, env: environment }).required, false);
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
    assert.equal(claude.permissions.allow.includes("mcp__waypost__waypost_claim_history"), true);

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
  const home = path.join(temporary, "home with spaces");
  const project = path.join(temporary, "project");
  const bin = path.join(temporary, "bin with spaces");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    WAYPOST_STATE_DIR: path.join(temporary, "waypost state"),
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
    assert.equal(configured.paths.agySettings, path.join(home, ".gemini", "antigravity-cli", "settings.json"));

    const agy = JSON.parse(fs.readFileSync(paths.agySettings, "utf8"));
    const waypost = fs.realpathSync(path.join(bin, "waypost"));
    const stateDir = path.resolve(environment.WAYPOST_STATE_DIR);
    const quotedWaypostDoc = `command('${waypost}' doc)`;
    const quotedWaypostRead = `command('${waypost}' --state-dir '${stateDir}' read)`;
    const quotedLauncher = `command('${path.join(home, ".local", "bin", "agentgear")}' skill get)`;
    assert.equal(agy.permissions.allow.includes(quotedWaypostDoc), true);
    assert.equal(agy.permissions.allow.includes(quotedWaypostRead), true);
    assert.equal(agy.permissions.allow.includes(quotedLauncher), true);
    assert.equal(agy.permissions.allow.includes(`command(${waypost} doc)`), false);
    assert.equal(agy.permissions.allow.includes("command(waypost)"), false);
    assert.equal(agy.permissions.allow.includes("command(waypost doc)"), false);
    assert.equal(agy.permissions.allow.includes("mcp(waypost/waypost_recv)"), true);
    assert.equal(agy.permissions.allow.includes("mcp(waypost/session_resolve)"), false);
    const agyClaims = JSON.parse(fs.readFileSync(paths.agyClaims, "utf8"));
    assert.equal(agyClaims.producer, "workflow");
    assert.deepEqual(agyClaims.permissions, agy.permissions.allow);

    agy.permissions.allow = agy.permissions.allow.filter(permission => permission !== quotedWaypostDoc);
    fs.writeFileSync(paths.agySettings, `${JSON.stringify(agy, null, 2)}\n`);
    const staleAgy = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(staleAgy.issues.some(issue => /Agy settings are missing/.test(issue)), true);
    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    const claude = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow.includes("mcp__waypost__session_resolve"), false);
    claude.permissions.allow = claude.permissions.allow.filter(permission => permission !== "mcp__waypost__session_require");
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);
    const stale = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(stale.ok, false);
    assert.equal(stale.issues.some(issue => /Claude settings are missing/.test(issue)), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("project-scoped permission init leaves Agy global settings untouched", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-project-agy-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const agyHome = path.join(temporary, "agy-home");
  const agySettings = path.join(agyHome, "settings.json");
  const original = `${JSON.stringify({ permissions: { allow: ["command(user-owned)"] } }, null, 2)}\n`;
  const environment = {
    HOME: home,
    AGENTGEAR_AGY_HOME: agyHome,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });
    fs.writeFileSync(agySettings, original);

    const paths = withEnvironment(environment, () => initializePermissions({ scope: "project", project }).paths);

    assert.equal(paths.agySettings, null);
    assert.equal(fs.readFileSync(agySettings, "utf8"), original);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agy configuration failure rolls back every workflow permission file", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-agy-permission-rollback-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const agyHome = path.join(temporary, "agy-home");
  const agySettings = path.join(agyHome, "settings.json");
  const invalidSettings = "{not json}\n";
  const environment = {
    HOME: home,
    AGENTGEAR_AGY_HOME: agyHome,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });
    fs.writeFileSync(agySettings, invalidSettings);

    assert.throws(
      () => withEnvironment(environment, () => initializePermissions({ scope: "user", project })),
      /failed to parse/
    );

    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    assert.equal(fs.readFileSync(agySettings, "utf8"), invalidSettings);
    assert.equal(fs.existsSync(paths.claudeSettings), false);
    assert.equal(fs.existsSync(paths.codexRules), false);
    assert.equal(fs.existsSync(paths.geminiPolicy), false);
    assert.equal(fs.existsSync(paths.agyClaims), false);
    assert.equal(fs.existsSync(paths.agyPermissionRegistry), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("user-scoped permission init retires the known config_files Codex rules", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-config-files-codex-migration-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  const legacyRules = path.join(home, ".codex", "rules", "agent-deck-workflow.rules");
  const currentRules = path.join(home, ".codex", "rules", "agentgear-workflow.rules");
  const legacySource = `prefix_rule(
    pattern=["agent-deck"],
    decision="allow",
)

prefix_rule(
    pattern=["~/.local/bin/adwf-send-and-wake"],
    decision="allow",
)
`;
  try {
    fs.mkdirSync(path.dirname(legacyRules), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(legacyRules, legacySource);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    assert.equal(fs.existsSync(legacyRules), false);
    assert.equal(fs.readFileSync(`${legacyRules}.agentgear-backup`, "utf8"), legacySource);
    assert.match(fs.readFileSync(currentRules, "utf8"), /# Agentgear workflow - generated approval rules/);
    assert.doesNotMatch(fs.readFileSync(currentRules, "utf8"), /adwf-send-and-wake/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("permission init archives a modified config_files Codex rules file instead of deleting it", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-modified-config-files-codex-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  const legacyRules = path.join(home, ".codex", "rules", "agent-deck-workflow.rules");
  const currentRules = path.join(home, ".codex", "rules", "agentgear-workflow.rules");
  const modifiedSource = `prefix_rule(
    pattern=["agent-deck"],
    decision="allow",
)

# User addition
prefix_rule(
    pattern=["custom-command"],
    decision="allow",
)
`;
  try {
    fs.mkdirSync(path.dirname(legacyRules), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(legacyRules, modifiedSource);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    assert.equal(fs.existsSync(legacyRules), false);
    assert.equal(fs.readFileSync(`${legacyRules}.agentgear-backup`, "utf8"), modifiedSource);
    assert.match(fs.readFileSync(currentRules, "utf8"), /# Agentgear workflow - generated approval rules/);
    assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), true);
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

test("workflow permissions recognize the trusted absolute Waypost command in Codex config", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-absolute-waypost-mcp-test-"));
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
    assert.equal(workflowWaypostMcpTools.includes("session_resolve"), false);
    const waypost = writeWaypostExecutable(bin);
    fs.mkdirSync(project, { recursive: true });
    const paths = withEnvironment(environment, () => permissionPaths("user", project));
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(
      paths.codexConfig,
      `[mcp_servers.waypost]\ncommand = ${JSON.stringify(waypost)}\nargs = ["mcp"]\n`
    );

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    const codex = fs.readFileSync(paths.codexConfig, "utf8");
    for (const tool of workflowWaypostMcpTools) {
      assert.match(codex, new RegExp(`mcp_servers\\.waypost\\.tools\\.${tool}`));
    }
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
    const legacyTools = [
      "session_create", "session_require", "session_resolve", "waypost_ack", "waypost_bind", "waypost_defer",
      "waypost_fail", "waypost_group_add_member", "waypost_group_add_subscriber", "waypost_group_create",
      "waypost_list", "waypost_read", "waypost_recv", "waypost_release", "waypost_send", "waypost_status"
    ];
    const legacySections = legacyTools
      .map(tool => `[mcp_servers.waypost.tools.${tool}]\napproval_mode = "approve"`)
      .join("\n\n");
    fs.writeFileSync(
      paths.codexConfig,
      `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n# Agentgear multi-agent-protocol Waypost MCP approvals\n${legacySections}\n`
    );

    const stale = findRetiredPermissionApprovals({ scope: "user", project, env: environment });
    assert.equal(stale.required, true);
    assert.equal(stale.issues.some(issue => /Codex config.*session_resolve/.test(issue)), true);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    const source = fs.readFileSync(paths.codexConfig, "utf8");
    assert.doesNotMatch(source, /# Agentgear multi-agent-protocol Waypost MCP approvals/);
    assert.match(source, /# BEGIN Agentgear Waypost MCP approvals/);
    assert.match(source, /# END Agentgear Waypost MCP approvals/);
    assert.doesNotMatch(source, /mcp_servers\.waypost\.tools\.waypost_fail/);
    assert.doesNotMatch(source, /mcp_servers\.waypost\.tools\.session_resolve/);
    assert.equal(fs.existsSync(paths.codexOwnership), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow permissions automatically reconcile orphaned Codex ownership", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-codex-orphaned-ownership-test-"));
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
    const existingApprovals = workflowWaypostMcpTools
      .map(tool => `[mcp_servers.waypost.tools.${tool}]\napproval_mode = "approve"`)
      .join("\n\n");
    fs.writeFileSync(
      paths.codexConfig,
      `[mcp_servers.waypost]\ncommand = "waypost"\nargs = ["mcp"]\n\n${existingApprovals}\n`
    );
    fs.writeFileSync(paths.codexOwnership, `${JSON.stringify({
      version: 1,
      tools: workflowWaypostMcpTools
    }, null, 2)}\n`);

    const stale = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(stale.issues.some(issue => /ownership exists without its generated approval block/.test(issue)), true);

    withEnvironment(environment, () => initializePermissions({ scope: "user", project }));

    assert.equal(fs.existsSync(paths.codexOwnership), false);
    const source = fs.readFileSync(paths.codexConfig, "utf8");
    for (const tool of workflowWaypostMcpTools) {
      assert.match(source, new RegExp(`mcp_servers\\.waypost\\.tools\\.${tool}`));
    }
    const configured = withEnvironment(environment, () => checkPermissions({ scope: "user", project }));
    assert.equal(configured.ok, true, configured.issues.join("\n"));
    assert.match(fs.readFileSync(paths.codexRules, "utf8"), /"skill", "get"/);
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

    const expectedRead = `Bash(${fs.realpathSync(waypost)} --state-dir ${path.resolve(stateDir)} read)`;
    const expectedReadWildcard = `${expectedRead.slice(0, -1)} *)`;
    const expectedFail = `Bash(${fs.realpathSync(waypost)} --state-dir ${path.resolve(stateDir)} fail)`;
    const expectedFailWildcard = `${expectedFail.slice(0, -1)} *)`;
    const expectedRenew = `Bash(${fs.realpathSync(waypost)} --state-dir ${path.resolve(stateDir)} renew)`;
    const expectedRenewWildcard = `${expectedRenew.slice(0, -1)} *)`;
    const additionalActions = ["forward", "wait", "undefer", "group", "address"];
    const additionalPermissions = additionalActions.flatMap(action => {
      const exact = `Bash(${fs.realpathSync(waypost)} --state-dir ${path.resolve(stateDir)} ${action})`;
      return [exact, `${exact.slice(0, -1)} *)`];
    });
    const expectedDoc = `Bash(${fs.realpathSync(waypost)} doc)`;
    const expectedDocWildcard = `${expectedDoc.slice(0, -1)} *)`;
    const claude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow.includes(expectedRead), true);
    assert.equal(claude.permissions.allow.includes(expectedReadWildcard), true);
    assert.equal(claude.permissions.allow.includes(expectedFail), true);
    assert.equal(claude.permissions.allow.includes(expectedFailWildcard), true);
    assert.equal(claude.permissions.allow.includes(expectedRenew), true);
    assert.equal(claude.permissions.allow.includes(expectedRenewWildcard), true);
    for (const permission of additionalPermissions) {
      assert.equal(claude.permissions.allow.includes(permission), true, `Claude permits ${permission}`);
    }
    assert.equal(claude.permissions.allow.includes(expectedDoc), true);
    assert.equal(claude.permissions.allow.includes(expectedDocWildcard), true);
    assert.equal(claude.permissions.allow.includes("Bash(waypost)"), false);
    assert.equal(claude.permissions.allow.includes("Bash(waypost *)"), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, ".claude", ".agentgear-workflow-permissions.json"), "utf8"));
    assert.equal(manifest.version, 4);
    assert.equal(manifest.rules.length, 20);
    assert.deepEqual(manifest.mcp_permissions, workflowWaypostMcpTools.map(tool => `mcp__waypost__${tool}`));

    const codex = fs.readFileSync(path.join(project, ".codex", "rules", "agentgear-workflow.rules"), "utf8");
    assert.match(codex, new RegExp(escapeRegex(waypost)));
    assert.match(codex, /"fail"/);
    assert.match(codex, /"renew"/);
    for (const action of additionalActions) assert.match(codex, new RegExp(`"${action}"`));
    assert.match(codex, new RegExp(`pattern = \\[${escapeRegex(JSON.stringify(fs.realpathSync(waypost)))}, "doc"\\]`));
    assert.doesNotMatch(codex, /pattern = \["waypost"/);

    const gemini = fs.readFileSync(path.join(project, ".gemini", "policies", "agentgear-workflow.toml"), "utf8");
    assert.match(gemini, /mcpName = "waypost"/);
    assert.match(gemini, new RegExp(escapeRegex(waypost)));
    assert.match(gemini, /"fail"/);
    assert.match(gemini, /"renew"/);
    for (const action of additionalActions) assert.match(gemini, new RegExp(`"${action}"`));
    assert.match(gemini, new RegExp(`commandPrefix = \\[${escapeRegex(JSON.stringify(fs.realpathSync(waypost)))}, "doc"\\]`));

    const userPermission = "Bash(/opt/custom-waypost --state-dir /tmp/custom-state read)";
    const retiredMcpFail = "mcp__waypost__waypost_fail";
    claude.permissions.allow = claude.permissions.allow.filter(permission =>
      permission !== expectedDoc
      && permission !== expectedDocWildcard
      && permission !== expectedRenew
      && permission !== expectedRenewWildcard
      && !additionalPermissions.includes(permission)
      && permission !== "mcp__waypost__waypost_claim_history"
    );
    claude.permissions.allow.push(userPermission, retiredMcpFail);
    fs.writeFileSync(claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);
    const manifestFile = path.join(project, ".claude", ".agentgear-workflow-permissions.json");
    const legacyManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    legacyManifest.version = 2;
    legacyManifest.permissions = legacyManifest.permissions.filter(permission => !/ doc(?: \*)?\)$/.test(permission));
    legacyManifest.permissions = legacyManifest.permissions.filter(permission => !/ (?:renew|forward|wait|undefer|group|address)(?: \*)?\)$/.test(permission));
    legacyManifest.rules = legacyManifest.rules.filter(rule => rule.action !== "doc" && !["renew", ...additionalActions].includes(rule.action));
    delete legacyManifest.mcp_permissions;
    fs.writeFileSync(manifestFile, `${JSON.stringify(legacyManifest)}\n`);
    withEnvironment({ ...environment, PATH: "" }, () => initializePermissions({ scope: "project", project }));

    const updatedClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(updatedClaude.permissions.allow.includes(expectedRead), false);
    assert.equal(updatedClaude.permissions.allow.includes(userPermission), true);
    for (const tool of workflowWaypostMcpTools) {
      assert.equal(updatedClaude.permissions.allow.includes(`mcp__waypost__${tool}`), false, `stale MCP grant ${tool} was removed`);
    }
    assert.equal(updatedClaude.permissions.allow.includes(retiredMcpFail), false, "retired v2 MCP fail grant was removed");
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
    assert.equal(settings.permissions.allow.includes(`Bash(${fs.realpathSync(waypost)} --state-dir ${path.resolve(stateDir)} read)`), true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.version, 4);
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
