#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  claudeWaypostPermission,
  isLegacyBroadWaypostPermission,
  legacyOwnershipManifestPath,
  ownershipManifestPath,
  readWaypostOwnershipManifest,
  removeWaypostOwnershipManifest,
  resolveWaypostPermissionContext,
  writeWaypostOwnershipManifest
} from "./waypost-permission-spec.mjs";

const usage = `Manage Agentgear workflow permissions for Claude Code, Codex, and Gemini CLI.

Usage:
  agentgear permissions init [--scope user|project] [--project DIR]
  agentgear permissions check [--scope user|project] [--project DIR] [--json]

Defaults:
  --scope user
  --project current directory

The generated rules invoke the stable ~/.local/bin/agentgear launcher. User
scope writes harness user configuration; project scope writes trusted-project
configuration under DIR.`;

const colors = {
  info: "\x1b[0;34m",
  ok: "\x1b[0;32m",
  warn: "\x1b[1;33m",
  error: "\x1b[0;31m",
  reset: "\x1b[0m"
};

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function commandCandidates(command, env = process.env) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return [command];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (env.PATH || "").split(path.delimiter).flatMap(directory =>
    extensions.map(extension => path.join(directory, command.endsWith(extension) ? command : command + extension))
  );
}

function resolveCommand(command, env = process.env) {
  for (const candidate of commandCandidates(command, env)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function isMain(metaUrl) {
  const invoked = process.argv[1] && path.resolve(process.argv[1]);
  return invoked === path.resolve(fileURLToPath(metaUrl));
}

async function execute(mainFunction) {
  try {
    await mainFunction();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

// Keep this list limited to the MCP operations used by the shipped workflow
// skills.  In particular, do not grant newly added Waypost operations merely
// because they happen to share the server.
export const workflowWaypostMcpTools = [
  "session_create",
  "session_require",
  "session_resolve",
  "waypost_ack",
  "waypost_bind",
  "waypost_defer",
  "waypost_fail",
  "waypost_group_add_member",
  "waypost_group_add_subscriber",
  "waypost_group_create",
  "waypost_list",
  "waypost_read",
  "waypost_recv",
  "waypost_release",
  "waypost_send",
  "waypost_status"
];

function log(kind, message) {
  process.stdout.write(`${colors[kind]}[${kind.toUpperCase()}]${colors.reset} ${message}\n`);
}

function getHome() {
  return process.env.HOME || os.homedir();
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(getHome(), ".codex");
}

export function permissionPaths(scope, projectDir) {
  const user = scope === "user";
  const configRoot = user ? path.resolve(getHome()) : projectDir;
  const codexRoot = user ? codexHome() : path.join(projectDir, ".codex");
  return {
    configRoot,
    claudeSettings: path.join(configRoot, ".claude", "settings.json"),
    codexRules: path.join(codexRoot, "rules", "agentgear-workflow.rules"),
    codexLegacyRules: path.join(codexRoot, "rules", "agent-deck-workflow.rules"),
    codexConfig: path.join(codexRoot, "config.toml"),
    codexUserConfig: path.join(codexHome(), "config.toml"),
    geminiPolicy: path.join(configRoot, ".gemini", "policies", "agentgear-workflow.toml"),
    geminiLegacyPolicy: path.join(configRoot, ".gemini", "policies", "agent-deck-workflow.toml")
  };
}

function parsePermissionOptions(argv) {
  const [action, ...argumentsList] = argv;
  if (!action || action === "--help" || action === "-h") return { help: true };
  if (!['init', 'check'].includes(action)) throw new Error(`Unknown permissions command: ${action}`);
  const options = { action, scope: "user", project: process.cwd(), json: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (index >= argumentsList.length) throw new Error(`Missing value for ${argument}`);
      return argumentsList[index];
    };
    switch (argument) {
      case "--scope":
        options.scope = next();
        break;
      case "--project":
        options.project = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown permissions option: ${argument}`);
    }
  }
  if (!['user', 'project'].includes(options.scope)) {
    throw new Error(`Invalid permissions scope: ${options.scope}. Use user or project.`);
  }
  if (options.action === "init" && options.json) throw new Error("--json is only valid with permissions check");
  options.project = path.resolve(options.project);
  return options;
}

function resolveProjectDir(requestedProjectDir) {
  if (!fs.statSync(requestedProjectDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`project directory does not exist: ${requestedProjectDir}`);
  }
  return fs.realpathSync(requestedProjectDir);
}

function writeAtomic(filePath, content) {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`refusing symlinked or non-file path: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content);
  if (existing) fs.chmodSync(temporary, existing.mode & 0o777);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function jsonPermission(command) {
  return `Bash(${command})`;
}

function waypostContext(projectDir, { quiet = false } = {}) {
  const context = resolveWaypostPermissionContext({ projectDir });
  if (!context.trusted && !quiet) {
    log("warn", `Skipping Waypost-specific permissions: ${context.reason}`);
  }
  return context;
}

function launcherForms() {
  const absolute = path.join(getHome(), ".local", "bin", "agentgear");
  return ["agentgear", "~/.local/bin/agentgear", absolute];
}

function adwfForms() {
  const absolute = path.join(getHome(), ".local", "bin", "adwf-send-and-wake");
  return ["~/.local/bin/adwf-send-and-wake", absolute];
}

function generatedClaudePermissions(waypost) {
  const permissions = [
    jsonPermission("agent-deck"), jsonPermission("agent-deck *"),
    "Bash(git diff)", "Bash(git diff *)", "Bash(git show)", "Bash(git show *)", "Bash(git status)", "Bash(git status *)", "Bash(git log)", "Bash(git log *)", "Bash(git rev-parse)", "Bash(git rev-parse *)",
    ...adwfForms().map(command => jsonPermission(`${command} *`)),
    ...launcherForms().map(command => jsonPermission(`${command} run multi-agent-protocol *`)),
    ...launcherForms().map(command => jsonPermission(`${command} resolve-tool-command *`)),
    "Write(/.agent-artifacts/**)"
  ];
  permissions.push(...waypost.rules.map(claudeWaypostPermission));
  permissions.push(...generatedClaudeMcpPermissions(waypost));
  return [...new Set(permissions)];
}

function generatedClaudeMcpPermissions(waypost) {
  return waypost.trusted
    ? workflowWaypostMcpTools.map(name => `mcp__waypost__${name}`)
    : [];
}

function isSafeRegularFile(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function configureClaude(configRoot, waypost) {
  log("info", "Configuring Claude Code permissions...");
  const settingsFile = path.join(configRoot, ".claude", "settings.json");
  const settingsInfo = fs.lstatSync(settingsFile, { throwIfNoEntry: false });
  if (settingsInfo && !isSafeRegularFile(settingsFile)) {
    throw new Error(`refusing symlinked or non-file Claude settings path: ${settingsFile}`);
  }
  const alreadyExists = Boolean(settingsInfo);
  const ownership = readWaypostOwnershipManifest(configRoot);
  // Version 2 predated MCP ownership records but generated this exact static
  // list whenever Waypost was trusted. Treat it as legacy installer-owned
  // during one migration pass, then persist explicit v3 ownership.
  const legacyMcpPermissions = ownership.version === 2
    ? workflowWaypostMcpTools.map(name => `mcp__waypost__${name}`)
    : [];
  const ownedWaypostPermissions = new Set([
    ...ownership.permissions,
    ...ownership.mcpPermissions,
    ...legacyMcpPermissions
  ]);
  let settings = {};
  let originalSettings = "";
  if (alreadyExists) {
    log("info", "Merging permissions into existing settings.json");
    const backup = `${settingsFile}.backup.${nowIso().replace(/[-:TZ]/g, "")}`;
    fs.copyFileSync(settingsFile, backup);
    try {
      originalSettings = fs.readFileSync(settingsFile, "utf8");
      settings = JSON.parse(originalSettings);
    } catch (error) {
      throw new Error(`Failed to parse ${settingsFile}: ${error.message}`);
    }
  } else {
    log("info", "Creating new settings.json");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) settings.permissions = {};
  const prior = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  settings.permissions.allow = [...new Set([
    ...prior.filter(item => !ownedWaypostPermissions.has(item) && (ownership.present || !isLegacyBroadWaypostPermission(item))),
    ...generatedClaudePermissions(waypost)
  ])];
  writeAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  try {
    if (waypost.trusted) {
      writeWaypostOwnershipManifest(configRoot, waypost.rules, generatedClaudeMcpPermissions(waypost));
    } else {
      removeWaypostOwnershipManifest(configRoot);
    }
  } catch (error) {
    if (alreadyExists) writeAtomic(settingsFile, originalSettings);
    else fs.rmSync(settingsFile, { force: true });
    throw error;
  }
  log("ok", `${alreadyExists ? "Merged permissions into" : "Created"} ${settingsFile}`);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function codexRule(pattern, justification, extra = "") {
  return `prefix_rule(\n    pattern = [${pattern.map(tomlString).join(", ")}],\n    decision = "allow",\n    justification = ${tomlString(justification)},${extra}\n)\n`;
}

function codexWaypostServerIsConfigured(source) {
  const lines = source.split(/\r?\n/);
  let inWaypostSection = false;
  let command = false;
  let args = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inWaypostSection) break;
      inWaypostSection = /^\s*\[\s*mcp_servers\.(?:waypost|"waypost")\s*\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (!inWaypostSection) continue;
    if (/^\s*command\s*=\s*"waypost"\s*(?:#.*)?$/.test(line)) command = true;
    if (/^\s*args\s*=\s*\[\s*"mcp"(?:\s*,[^\]]*)?\]\s*(?:#.*)?$/.test(line)) args = true;
  }
  return inWaypostSection && command && args;
}

function codexWaypostToolSection(name) {
  return `[mcp_servers.waypost.tools.${name}]`;
}

function codexWaypostUsesInlineTools(source) {
  const lines = source.split(/\r?\n/);
  let inWaypostSection = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inWaypostSection) return false;
      inWaypostSection = /^\s*\[\s*mcp_servers\.(?:waypost|"waypost")\s*\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (inWaypostSection && /^\s*tools\s*=/.test(line)) return true;
  }
  return false;
}

function configureCodexWaypostMcpPermissions(waypost, paths) {
  if (!waypost.trusted) return;
  const configFile = paths.codexConfig;
  const info = fs.lstatSync(configFile, { throwIfNoEntry: false });
  if (info && !isSafeRegularFile(configFile)) {
    throw new Error(`refusing symlinked or non-file Codex config path: ${configFile}`);
  }
  const source = info ? fs.readFileSync(configFile, "utf8") : "";
  const userSource = paths.codexUserConfig !== configFile
    && isSafeRegularFile(paths.codexUserConfig)
    ? fs.readFileSync(paths.codexUserConfig, "utf8")
    : "";
  if (!codexWaypostServerIsConfigured(source) && !codexWaypostServerIsConfigured(userSource)) {
    log("warn", `Skipping Codex Waypost MCP approvals: configure the Waypost MCP server first (${paths.codexUserConfig})`);
    return;
  }
  const missing = workflowWaypostMcpTools.filter(name => !source.includes(codexWaypostToolSection(name)));
  if (missing.length === 0) {
    log("ok", "Codex Waypost MCP approvals are already configured");
    return;
  }
  if (codexWaypostUsesInlineTools(source)) {
    throw new Error(`refusing to extend inline Waypost tools in ${configFile}; convert 'tools = {...}' to explicit TOML tables first`);
  }
  const separator = source.endsWith("\n") ? "\n" : "\n\n";
  const additions = missing.map(name => `${codexWaypostToolSection(name)}\napproval_mode = "approve"`).join("\n\n");
  writeAtomic(configFile, `${source}${separator}# Agentgear multi-agent-protocol Waypost MCP approvals\n${additions}\n`);
  log("ok", `Added ${missing.length} Codex Waypost MCP approval${missing.length === 1 ? "" : "s"}: ${configFile}`);
}

function codexRulesSource(waypost) {
  return [
    "# Agentgear workflow - generated approval rules\n",
    codexRule(["agent-deck"], "Agent Deck workflow commands", '\n    match = [\n        "agent-deck",\n        "agent-deck status",\n        "agent-deck session current",\n        "agent-deck workflow dispatch",\n    ]'),
    codexRule(["printf"], "Shell formatting helper commands"),
    ...adwfForms().map(command => codexRule([command], "Workflow send+wakeup helper")),
    ...launcherForms().map(command => codexRule([command, "run", "multi-agent-protocol"], "Protocol scripts through the managed agentgear launcher")),
    ...launcherForms().map(command => codexRule([command, "resolve-tool-command"], "Workflow launch-candidate resolver through Agentgear")),
    ...waypost.rules.filter(item => !item.wildcard).map(item => codexRule([item.command, "--state-dir", item.stateDir, item.action], "Waypost query; host permission required")),
    "# Waypost reads and writes require host permission.\n"
  ].join("\n");
}

function validateLegacyGeneratedFile(filePath, marker) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info) return false;
  if (!isSafeRegularFile(filePath)) throw new Error(`refusing symlinked or non-file legacy permission path: ${filePath}`);
  const source = fs.readFileSync(filePath, "utf8");
  if (!source.includes(marker)) throw new Error(`refusing to remove unrecognized legacy permission file: ${filePath}`);
  return true;
}

function configureCodex(projectDir, waypost, paths) {
  log("info", "Configuring Codex escalation rules...");
  const retireLegacy = validateLegacyGeneratedFile(paths.codexLegacyRules, "# Multi-Agent Protocol - generated approval rules");
  writeAtomic(paths.codexRules, codexRulesSource(waypost));
  if (retireLegacy) fs.rmSync(paths.codexLegacyRules);
  log("ok", `Created ${paths.codexRules}`);
  configureCodexWaypostMcpPermissions(waypost, paths);

  // Updating an existing TOML config without a TOML parser risks clobbering
  // user settings. Surface the rare external-worktree case instead.
  if (process.platform === "linux" && resolveCommand("git")) {
    const result = childProcess.spawnSync("git", ["-C", projectDir, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (result.status === 0) {
      const common = path.resolve(projectDir, result.stdout.trim());
      if (!common.startsWith(`${projectDir}${path.sep}`)) log("info", `External git metadata detected: add ${common} to Codex writable_roots if the host asks for it.`);
    }
  }
}

function geminiRule(name, commandPrefix, toolName = "run_shell_command") {
  return `[[rule]]\nname = ${tomlString(name)}\nenabled = true\ndecision = "allow"\ntoolName = ${tomlString(toolName)}\ncommandPrefix = [${commandPrefix.map(tomlString).join(", ")}]\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`;
}

function geminiPolicySource(waypost) {
  return [
    "# Agentgear workflow - generated policy rules\n",
    geminiRule("allow_agent_deck_cli", ["agent-deck"]),
    ...(waypost.trusted ? [`[[rule]]\nname = "allow_waypost_mcp"\nenabled = true\ndecision = "allow"\ntoolName = "*"\nmcpName = "waypost"\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`] : []),
    ...adwfForms().map((command, index) => geminiRule(`allow_adwf_send_and_wake_${index}`, [command])),
    ...launcherForms().map((command, index) => geminiRule(`allow_multi_agent_protocol_launcher_${index}`, [command, "run", "multi-agent-protocol"])),
    ...launcherForms().map((command, index) => geminiRule(`allow_agentgear_resolve_tool_command_${index}`, [command, "resolve-tool-command"])),
    ...waypost.rules.filter(item => !item.wildcard).map((item, index) => geminiRule(`allow_waypost_cli_${item.action}_${index}`, [item.command, "--state-dir", item.stateDir, item.action])),
    "# Waypost reads and writes require host permission.\n"
  ].join("\n");
}

function configureGemini(waypost, paths) {
  log("info", "Configuring Gemini CLI shell policies...");
  const retireLegacy = validateLegacyGeneratedFile(paths.geminiLegacyPolicy, "# Multi-Agent Protocol - generated policy rules");
  writeAtomic(paths.geminiPolicy, geminiPolicySource(waypost));
  if (retireLegacy) fs.rmSync(paths.geminiLegacyPolicy);
  log("ok", `Created ${paths.geminiPolicy}`);
}

function readRegularText(filePath, label, issues) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info) {
    issues.push(`${label} is missing: ${filePath}`);
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    issues.push(`${label} is not a safe regular file: ${filePath}`);
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function checkClaude(paths, waypost, issues) {
  const source = readRegularText(paths.claudeSettings, "Claude settings", issues);
  if (source === null) return;
  let settings;
  try {
    settings = JSON.parse(source);
  } catch (error) {
    issues.push(`Claude settings are invalid JSON: ${error.message}`);
    return;
  }
  const allowed = new Set(Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : []);
  const missing = generatedClaudePermissions(waypost).filter(permission => !allowed.has(permission));
  if (missing.length > 0) issues.push(`Claude settings are missing ${missing.length} Agentgear permission(s)`);
  if (waypost.trusted) {
    try {
      const ownership = readWaypostOwnershipManifest(paths.configRoot);
      if (!ownership.present) issues.push(`Claude ownership manifest is missing: ${ownershipManifestPath(paths.configRoot)}`);
      if (ownership.manifestPath === legacyOwnershipManifestPath(paths.configRoot)) {
        issues.push(`Claude ownership manifest still uses the legacy Agent Deck name: ${ownership.manifestPath}`);
      }
    } catch (error) {
      issues.push(error.message);
    }
  }
}

function checkCodex(paths, waypost, issues) {
  const rules = readRegularText(paths.codexRules, "Codex rules", issues);
  if (rules !== null && rules !== codexRulesSource(waypost)) issues.push(`Codex rules are out of date: ${paths.codexRules}`);
  if (fs.lstatSync(paths.codexLegacyRules, { throwIfNoEntry: false })) {
    issues.push(`Legacy Codex workflow rules remain: ${paths.codexLegacyRules}`);
  }
  if (!waypost.trusted) return;
  const source = readRegularText(paths.codexConfig, "Codex config", issues);
  const userSource = paths.codexUserConfig !== paths.codexConfig
    && isSafeRegularFile(paths.codexUserConfig)
    ? fs.readFileSync(paths.codexUserConfig, "utf8")
    : "";
  if (!codexWaypostServerIsConfigured(source ?? "") && !codexWaypostServerIsConfigured(userSource)) {
    issues.push(`Codex does not configure Waypost MCP in ${paths.codexConfig} or ${paths.codexUserConfig}`);
  }
  if (source !== null) {
    const missing = workflowWaypostMcpTools.filter(name => !source.includes(codexWaypostToolSection(name)));
    if (missing.length > 0) issues.push(`Codex config is missing ${missing.length} Waypost MCP approval(s): ${paths.codexConfig}`);
  }
}

function checkGemini(paths, waypost, issues) {
  const source = readRegularText(paths.geminiPolicy, "Gemini policy", issues);
  if (source !== null && source !== geminiPolicySource(waypost)) issues.push(`Gemini policy is out of date: ${paths.geminiPolicy}`);
  if (fs.lstatSync(paths.geminiLegacyPolicy, { throwIfNoEntry: false })) {
    issues.push(`Legacy Gemini workflow policy remains: ${paths.geminiLegacyPolicy}`);
  }
}

export function checkPermissions({ scope = "user", project = process.cwd() } = {}) {
  const projectDir = resolveProjectDir(path.resolve(project));
  const paths = permissionPaths(scope, projectDir);
  const waypost = waypostContext(projectDir, { quiet: true });
  const issues = [];
  if (!waypost.trusted) issues.push(`Waypost permission context is not trusted: ${waypost.reason}`);
  checkClaude(paths, waypost, issues);
  checkCodex(paths, waypost, issues);
  checkGemini(paths, waypost, issues);
  return { ok: issues.length === 0, scope, project: projectDir, issues, paths };
}

export function initializePermissions({ scope = "user", project = process.cwd() } = {}) {
  const projectDir = resolveProjectDir(path.resolve(project));
  const paths = permissionPaths(scope, projectDir);
  const waypost = waypostContext(projectDir);
  process.stdout.write("\n========================================\n  Agentgear Workflow Permission Setup\n========================================\n\n");
  log("info", `Initializing Agentgear permissions (${scope} scope; project context: ${projectDir})`);
  if (!resolveCommand("agent-deck") && !resolveCommand("thurbox-cli")) {
    log("warn", "No supported persistent-session host found on PATH (agent-deck or thurbox-cli)");
  }
  configureClaude(paths.configRoot, waypost);
  configureCodex(projectDir, waypost, paths);
  configureGemini(waypost, paths);
  process.stdout.write("\n========================================\n  Configuration Complete\n========================================\n\n");
  log("ok", "Permissions configured for multi-agent-protocol");
  log("info", "Restart existing agent sessions so they reload the updated permission files.");
  return { scope, project: projectDir, paths };
}

export function runPermissionsCommand(argv = process.argv.slice(2)) {
  const options = parsePermissionOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (options.action === "init") {
    initializePermissions(options);
    return;
  }
  const result = checkPermissions(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Permissions are configured for ${result.scope} scope.\n`);
  } else {
    process.stdout.write(`Permission check failed for ${result.scope} scope:\n`);
    for (const issue of result.issues) process.stdout.write(`  - ${issue}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

export const main = runPermissionsCommand;

if (isMain(import.meta.url)) execute(() => runPermissionsCommand());
