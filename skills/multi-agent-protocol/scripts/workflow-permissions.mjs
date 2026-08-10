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

const CODEX_OWNERSHIP_VERSION = 1;
const CODEX_BLOCK_BEGIN = "# BEGIN Agentgear Waypost MCP approvals";
const CODEX_BLOCK_END = "# END Agentgear Waypost MCP approvals";
const CODEX_LEGACY_MARKER = "# Agentgear multi-agent-protocol Waypost MCP approvals";
const CODEX_TOOL_NAME = /^[A-Za-z0-9_]+$/;

function log(kind, message) {
  process.stdout.write(`${colors[kind]}[${kind.toUpperCase()}]${colors.reset} ${message}\n`);
}

function getHome(env = process.env) {
  return env.HOME || os.homedir();
}

function codexHome(env = process.env) {
  return env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(getHome(env), ".codex");
}

export function permissionPaths(scope, projectDir, env = process.env) {
  const user = scope === "user";
  const configRoot = user ? path.resolve(getHome(env)) : projectDir;
  const codexRoot = user ? codexHome(env) : path.join(projectDir, ".codex");
  return {
    configRoot,
    claudeSettings: path.join(configRoot, ".claude", "settings.json"),
    codexRules: path.join(codexRoot, "rules", "agentgear-workflow.rules"),
    codexLegacyRules: path.join(codexRoot, "rules", "agent-deck-workflow.rules"),
    codexConfig: path.join(codexRoot, "config.toml"),
    codexOwnership: path.join(codexRoot, ".agentgear-workflow-permissions.json"),
    codexUserConfig: path.join(codexHome(env), "config.toml"),
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

function permissionMutationPaths(paths) {
  return [...new Set([
    paths.claudeSettings,
    ownershipManifestPath(paths.configRoot),
    legacyOwnershipManifestPath(paths.configRoot),
    paths.codexRules,
    paths.codexLegacyRules,
    paths.codexConfig,
    paths.codexOwnership,
    paths.geminiPolicy,
    paths.geminiLegacyPolicy
  ])];
}

function capturePermissionFiles(paths) {
  return permissionMutationPaths(paths).map(filePath => {
    const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!info) return { filePath, present: false };
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`refusing symlinked or non-file permission path: ${filePath}`);
    }
    return {
      filePath,
      present: true,
      content: fs.readFileSync(filePath),
      mode: info.mode & 0o777
    };
  });
}

function removeRollbackFile(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`refusing unexpected rollback path: ${filePath}`);
  }
  fs.rmSync(filePath);
}

function restorePermissionFiles(snapshots) {
  const errors = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (!snapshot.present) {
        removeRollbackFile(snapshot.filePath);
        continue;
      }
      writeAtomic(snapshot.filePath, snapshot.content);
      fs.chmodSync(snapshot.filePath, snapshot.mode);
    } catch (error) {
      errors.push(`${snapshot.filePath}: ${error.message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
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

function retiredClaudePermissions(env = process.env) {
  const absolute = path.join(getHome(env), ".local", "bin", "adwf-send-and-wake");
  return [
    "Bash(~/.local/bin/adwf-send-and-wake *)",
    `Bash(${absolute} *)`
  ];
}

function readRetiredPermissionFile(filePath, label) {
  try {
    const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!info) return { source: null, issue: null };
    if (!info.isFile() || info.isSymbolicLink()) {
      return {
        source: null,
        issue: `${label} cannot be safely inspected for retired Agentgear permissions: ${filePath}`
      };
    }
    return { source: fs.readFileSync(filePath, "utf8"), issue: null };
  } catch (error) {
    return {
      source: null,
      issue: `${label} could not be inspected for retired Agentgear permissions (${error.code ?? "read error"}): ${filePath}`
    };
  }
}

function retiredClaudePermissionIssue(filePath, env) {
  const inspected = readRetiredPermissionFile(filePath, "Claude settings");
  if (inspected.issue || inspected.source === null) return inspected.issue;
  let settings;
  try {
    settings = JSON.parse(inspected.source);
  } catch {
    return inspected.source.includes("adwf-send-and-wake")
      ? `Claude settings mention retired command adwf-send-and-wake but are not valid JSON: ${filePath}`
      : null;
  }
  const allowed = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const retired = new Set(retiredClaudePermissions(env));
  return allowed.some(permission => retired.has(permission))
    ? `Claude settings retain an approval for retired command adwf-send-and-wake: ${filePath}`
    : null;
}

function retiredGeneratedPermissionIssue(filePath, label) {
  const inspected = readRetiredPermissionFile(filePath, label);
  if (inspected.issue || inspected.source === null) return inspected.issue;
  return inspected.source.includes("adwf-send-and-wake")
    ? `${label} retains an approval for retired command adwf-send-and-wake: ${filePath}`
    : null;
}

export function findRetiredPermissionApprovals({
  scope = "user",
  project = process.cwd(),
  env = process.env
} = {}) {
  if (!["user", "project"].includes(scope)) {
    throw new Error(`Invalid permissions scope: ${scope}. Use user or project.`);
  }
  const projectDir = path.resolve(project);
  const paths = permissionPaths(scope, projectDir, env);
  const issues = [];
  const claudeIssue = retiredClaudePermissionIssue(paths.claudeSettings, env);
  if (claudeIssue) issues.push(claudeIssue);
  for (const [filePath, label] of [
    [paths.codexRules, "Codex rules"],
    [paths.codexLegacyRules, "Legacy Codex rules"],
    [paths.geminiPolicy, "Gemini policy"],
    [paths.geminiLegacyPolicy, "Legacy Gemini policy"]
  ]) {
    const issue = retiredGeneratedPermissionIssue(filePath, label);
    if (issue) issues.push(issue);
  }
  return {
    required: issues.length > 0,
    scope,
    project: projectDir,
    issues,
    paths
  };
}

function generatedClaudePermissions(waypost) {
  const permissions = [
    jsonPermission("agent-deck"), jsonPermission("agent-deck *"),
    "Bash(git diff)", "Bash(git diff *)", "Bash(git show)", "Bash(git show *)", "Bash(git status)", "Bash(git status *)", "Bash(git log)", "Bash(git log *)", "Bash(git rev-parse)", "Bash(git rev-parse *)",
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
  const retiredPermissions = new Set(retiredClaudePermissions());
  settings.permissions.allow = [...new Set([
    ...prior.filter(item => !retiredPermissions.has(item) && !ownedWaypostPermissions.has(item) && (ownership.present || !isLegacyBroadWaypostPermission(item))),
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

function codexCommandValue(line) {
  const match = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function codexWaypostCommandIsTrusted(configuredCommand, trustedCommand) {
  if (configuredCommand === "waypost") return true;
  if (!trustedCommand || !path.isAbsolute(configuredCommand)) return false;
  try {
    return fs.realpathSync(configuredCommand) === fs.realpathSync(trustedCommand);
  } catch {
    return false;
  }
}

function codexWaypostServerIsConfigured(source, trustedCommand) {
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
    const configuredCommand = codexCommandValue(line);
    if (configuredCommand !== null) {
      command = codexWaypostCommandIsTrusted(configuredCommand, trustedCommand);
    }
    if (/^\s*args\s*=\s*\[\s*"mcp"(?:\s*,[^\]]*)?\]\s*(?:#.*)?$/.test(line)) args = true;
  }
  return inWaypostSection && command && args;
}

function codexWaypostToolSection(name) {
  return `[mcp_servers.waypost.tools.${name}]`;
}

function codexWaypostToolSource(name) {
  return `${codexWaypostToolSection(name)}\napproval_mode = "approve"`;
}

function codexToolSectionMatches(line, name) {
  const section = line.trim().replace(/\s+#.*$/, "");
  return section === codexWaypostToolSection(name)
    || section === `[mcp_servers.waypost.tools."${name}"]`
    || section === `[mcp_servers.waypost.tools.'${name}']`;
}

function codexToolApprovalMode(source, name) {
  const lines = source.split(/\r?\n/);
  let inToolSection = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inToolSection) break;
      inToolSection = codexToolSectionMatches(line, name);
      continue;
    }
    if (!inToolSection) continue;
    const match = /^\s*approval_mode\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
    if (match) return match[1];
  }
  return inToolSection ? "missing" : null;
}

function stableCodexOwnedTools(tools) {
  if (!Array.isArray(tools) || tools.length > 64) {
    throw new Error("invalid Codex Waypost ownership tool set");
  }
  if (!tools.every(tool => typeof tool === "string" && CODEX_TOOL_NAME.test(tool))) {
    throw new Error("invalid Codex Waypost ownership tool");
  }
  if (new Set(tools).size !== tools.length) {
    throw new Error("Codex Waypost ownership tools are not unique");
  }
  return tools;
}

function codexOwnedBlock(tools) {
  const stable = stableCodexOwnedTools(tools);
  if (stable.length === 0) return "";
  const sections = stable.map(codexWaypostToolSource).join("\n\n");
  return `${CODEX_BLOCK_BEGIN}\n${sections}\n${CODEX_BLOCK_END}\n`;
}

function readCodexOwnership(paths) {
  const info = fs.lstatSync(paths.codexOwnership, { throwIfNoEntry: false });
  if (!info) return { present: false, tools: [] };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`refusing invalid Codex permission ownership file: ${paths.codexOwnership}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.codexOwnership, "utf8"));
  } catch {
    throw new Error(`refusing malformed Codex permission ownership file: ${paths.codexOwnership}`);
  }
  if (!manifest || manifest.version !== CODEX_OWNERSHIP_VERSION) {
    throw new Error(`refusing invalid Codex permission ownership file: ${paths.codexOwnership}`);
  }
  return { present: true, tools: stableCodexOwnedTools(manifest.tools) };
}

function writeCodexOwnership(paths, tools) {
  const stable = stableCodexOwnedTools(tools);
  if (stable.length === 0) {
    const info = fs.lstatSync(paths.codexOwnership, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`refusing invalid Codex permission ownership file: ${paths.codexOwnership}`);
    }
    fs.rmSync(paths.codexOwnership);
    return;
  }
  writeAtomic(paths.codexOwnership, `${JSON.stringify({
    version: CODEX_OWNERSHIP_VERSION,
    tools: stable
  }, null, 2)}\n`);
}

function parseCodexToolSections(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const tools = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index] === "") index += 1;
    if (index >= lines.length) break;
    const match = /^\[mcp_servers\.waypost\.tools\.([A-Za-z0-9_]+)\]$/.exec(lines[index]);
    if (!match || lines[index + 1] !== 'approval_mode = "approve"') {
      throw new Error("refusing malformed Agentgear Codex Waypost approval block");
    }
    tools.push(match[1]);
    index += 2;
  }
  return stableCodexOwnedTools(tools);
}

function stripCodexOwnedBlock(source, ownership) {
  const beginToken = `${CODEX_BLOCK_BEGIN}\n`;
  const begin = source.indexOf(beginToken);
  if (begin !== -1) {
    if (source.indexOf(beginToken, begin + beginToken.length) !== -1) {
      throw new Error("refusing duplicate Agentgear Codex Waypost approval blocks");
    }
    const endToken = `${CODEX_BLOCK_END}\n`;
    const end = source.indexOf(endToken, begin + beginToken.length);
    if (end === -1) throw new Error("refusing unterminated Agentgear Codex Waypost approval block");
    const body = source.slice(begin + beginToken.length, end);
    const tools = parseCodexToolSections(body);
    if (ownership.present && JSON.stringify(tools) !== JSON.stringify(ownership.tools)) {
      throw new Error("refusing modified Agentgear-owned Codex Waypost approval block");
    }
    return {
      source: source.slice(0, begin) + source.slice(end + endToken.length),
      tools,
      legacy: !ownership.present
    };
  }
  if (ownership.present) {
    throw new Error("Codex permission ownership exists without its generated approval block");
  }

  const legacyToken = `${CODEX_LEGACY_MARKER}\n`;
  const legacy = source.indexOf(legacyToken);
  if (legacy === -1) return { source, tools: [], legacy: false };
  if (source.indexOf(legacyToken, legacy + legacyToken.length) !== -1) {
    throw new Error("refusing duplicate legacy Agentgear Codex Waypost approval blocks");
  }
  const tools = parseCodexToolSections(source.slice(legacy + legacyToken.length));
  if (tools.length === 0 || tools.some(tool => !workflowWaypostMcpTools.includes(tool))) {
    throw new Error("refusing unrecognized legacy Agentgear Codex Waypost approval block");
  }
  return { source: source.slice(0, legacy), tools, legacy: true };
}

function appendCodexOwnedBlock(source, tools) {
  const block = codexOwnedBlock(tools);
  if (!block) return source;
  const separator = source.length === 0 ? "" : (source.endsWith("\n") ? "\n" : "\n\n");
  return `${source}${separator}${block}`;
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
  const configFile = paths.codexConfig;
  const info = fs.lstatSync(configFile, { throwIfNoEntry: false });
  if (info && !isSafeRegularFile(configFile)) {
    throw new Error(`refusing symlinked or non-file Codex config path: ${configFile}`);
  }
  const source = info ? fs.readFileSync(configFile, "utf8") : "";
  const ownership = readCodexOwnership(paths);
  const stripped = stripCodexOwnedBlock(source, ownership);
  const userSource = paths.codexUserConfig !== configFile
    && isSafeRegularFile(paths.codexUserConfig)
    ? fs.readFileSync(paths.codexUserConfig, "utf8")
    : "";
  const configured = codexWaypostServerIsConfigured(stripped.source, waypost.command)
    || codexWaypostServerIsConfigured(userSource, waypost.command);
  if (waypost.trusted && !configured) {
    log("warn", `Removing Codex Waypost MCP approvals until the server is configured (${paths.codexUserConfig})`);
  }
  const desired = waypost.trusted && configured ? workflowWaypostMcpTools : [];
  const conflicts = desired.filter(name => {
    const mode = codexToolApprovalMode(stripped.source, name);
    return mode !== null && mode !== "approve";
  });
  if (conflicts.length > 0) {
    throw new Error(
      `refusing to override user-managed Codex Waypost approval mode for: ${conflicts.join(", ")}`
    );
  }
  const owned = desired.filter(name => codexToolApprovalMode(stripped.source, name) === null);
  if (owned.length > 0 && codexWaypostUsesInlineTools(stripped.source)) {
    throw new Error(`refusing to extend inline Waypost tools in ${configFile}; convert 'tools = {...}' to explicit TOML tables first`);
  }
  const nextSource = appendCodexOwnedBlock(stripped.source, owned);
  if (nextSource !== source) {
    if (nextSource.length === 0 && !info) {
      // There is no config file to create when no approval is desired.
    } else {
      writeAtomic(configFile, nextSource);
    }
  }
  writeCodexOwnership(paths, owned);
  if (owned.length > 0) {
    log("ok", `Configured ${owned.length} Agentgear-owned Codex Waypost MCP approval${owned.length === 1 ? "" : "s"}: ${configFile}`);
  } else if (stripped.tools.length > 0) {
    log("ok", `Removed ${stripped.tools.length} stale Agentgear-owned Codex Waypost MCP approval${stripped.tools.length === 1 ? "" : "s"}: ${configFile}`);
  } else {
    log("ok", "No Agentgear-owned Codex Waypost MCP approvals are required");
  }
}

function codexRulesSource(waypost) {
  return [
    "# Agentgear workflow - generated approval rules\n",
    codexRule(["agent-deck"], "Agent Deck session-host commands", '\n    match = [\n        "agent-deck",\n        "agent-deck status",\n        "agent-deck session current",\n        "agent-deck workflow dispatch",\n    ]'),
    codexRule(["printf"], "Shell formatting helper commands"),
    ...launcherForms().map(command => codexRule([command, "run", "multi-agent-protocol"], "Protocol scripts through the managed agentgear launcher")),
    ...launcherForms().map(command => codexRule([command, "resolve-tool-command"], "Workflow launch-candidate resolver through Agentgear")),
    ...waypost.rules.filter(item => !item.wildcard).map(item => codexRule([item.command, "--state-dir", item.stateDir, item.action], "Waypost query; host permission required")),
    "# Waypost reads and writes require host permission.\n"
  ].join("\n");
}

function planLegacyPermissionArchive(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info) return null;
  if (!isSafeRegularFile(filePath)) throw new Error(`refusing symlinked or non-file legacy permission path: ${filePath}`);
  let backupPath = `${filePath}.agentgear-backup`;
  for (let suffix = 1; fs.lstatSync(backupPath, { throwIfNoEntry: false }); suffix += 1) {
    backupPath = `${filePath}.agentgear-backup.${suffix}`;
  }
  return { filePath, backupPath };
}

function archiveLegacyPermissionFiles(plans) {
  const archived = [];
  try {
    for (const plan of plans.filter(Boolean)) {
      fs.copyFileSync(plan.filePath, plan.backupPath, fs.constants.COPYFILE_EXCL);
      try {
        fs.rmSync(plan.filePath);
      } catch (error) {
        fs.rmSync(plan.backupPath, { force: true });
        throw error;
      }
      archived.push(plan);
      log("warn", `Archived legacy permission file as ${plan.backupPath}; review the backup before removing it`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of [...archived].reverse()) {
      try {
        fs.copyFileSync(plan.backupPath, plan.filePath, fs.constants.COPYFILE_EXCL);
        fs.rmSync(plan.backupPath);
      } catch (rollbackError) {
        rollbackErrors.push(`${plan.filePath}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      error.message += `; additionally failed to restore archived legacy files: ${rollbackErrors.join("; ")}`;
    }
    throw error;
  }
}

function configureCodex(projectDir, waypost, paths) {
  log("info", "Configuring Codex escalation rules...");
  const legacyArchive = planLegacyPermissionArchive(paths.codexLegacyRules);
  writeAtomic(paths.codexRules, codexRulesSource(waypost));
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
  return legacyArchive;
}

function geminiRule(name, commandPrefix, toolName = "run_shell_command") {
  return `[[rule]]\nname = ${tomlString(name)}\nenabled = true\ndecision = "allow"\ntoolName = ${tomlString(toolName)}\ncommandPrefix = [${commandPrefix.map(tomlString).join(", ")}]\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`;
}

function geminiPolicySource(waypost) {
  return [
    "# Agentgear workflow - generated policy rules\n",
    geminiRule("allow_agent_deck_cli", ["agent-deck"]),
    ...(waypost.trusted ? [`[[rule]]\nname = "allow_waypost_mcp"\nenabled = true\ndecision = "allow"\ntoolName = "*"\nmcpName = "waypost"\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`] : []),
    ...launcherForms().map((command, index) => geminiRule(`allow_multi_agent_protocol_launcher_${index}`, [command, "run", "multi-agent-protocol"])),
    ...launcherForms().map((command, index) => geminiRule(`allow_agentgear_resolve_tool_command_${index}`, [command, "resolve-tool-command"])),
    ...waypost.rules.filter(item => !item.wildcard).map((item, index) => geminiRule(`allow_waypost_cli_${item.action}_${index}`, [item.command, "--state-dir", item.stateDir, item.action])),
    "# Waypost reads and writes require host permission.\n"
  ].join("\n");
}

function configureGemini(waypost, paths) {
  log("info", "Configuring Gemini CLI shell policies...");
  const legacyArchive = planLegacyPermissionArchive(paths.geminiLegacyPolicy);
  writeAtomic(paths.geminiPolicy, geminiPolicySource(waypost));
  log("ok", `Created ${paths.geminiPolicy}`);
  return legacyArchive;
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
  const retired = retiredClaudePermissions().filter(permission => allowed.has(permission));
  if (retired.length > 0) issues.push(`Claude settings retain ${retired.length} retired Agentgear permission(s)`);
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
  let ownership = { present: false, tools: [] };
  try {
    ownership = readCodexOwnership(paths);
  } catch (error) {
    issues.push(error.message);
  }
  const configInfo = fs.lstatSync(paths.codexConfig, { throwIfNoEntry: false });
  let source = null;
  let managedTools = [];
  let baseSource = "";
  if (configInfo) {
    if (!configInfo.isFile() || configInfo.isSymbolicLink()) {
      issues.push(`Codex config is not a safe regular file: ${paths.codexConfig}`);
    } else {
      source = fs.readFileSync(paths.codexConfig, "utf8");
      try {
        const stripped = stripCodexOwnedBlock(source, ownership);
        managedTools = stripped.tools;
        baseSource = stripped.source;
        if (stripped.legacy) {
          issues.push(`Codex Waypost approvals still use legacy ownership markers: ${paths.codexConfig}`);
        }
      } catch (error) {
        issues.push(error.message);
      }
    }
  } else if (ownership.present) {
    issues.push(`Codex permission ownership exists without its config file: ${paths.codexOwnership}`);
  }
  if (!waypost.trusted) {
    if (managedTools.length > 0 || ownership.present) {
      issues.push(`Codex retains Agentgear-owned Waypost MCP approvals while Waypost is untrusted: ${paths.codexConfig}`);
    }
    return;
  }
  const userSource = paths.codexUserConfig !== paths.codexConfig
    && isSafeRegularFile(paths.codexUserConfig)
    ? fs.readFileSync(paths.codexUserConfig, "utf8")
    : "";
  if (!codexWaypostServerIsConfigured(baseSource, waypost.command)
    && !codexWaypostServerIsConfigured(userSource, waypost.command)) {
    issues.push(`Codex does not configure Waypost MCP in ${paths.codexConfig} or ${paths.codexUserConfig}`);
  }
  if (source !== null) {
    const missing = workflowWaypostMcpTools.filter(name => codexToolApprovalMode(source, name) !== "approve");
    if (missing.length > 0) issues.push(`Codex config is missing ${missing.length} Waypost MCP approval(s): ${paths.codexConfig}`);
  } else {
    issues.push(`Codex config is missing: ${paths.codexConfig}`);
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
  const snapshots = capturePermissionFiles(paths);
  try {
    configureClaude(paths.configRoot, waypost);
    const legacyArchives = [
      configureCodex(projectDir, waypost, paths),
      configureGemini(waypost, paths)
    ];
    archiveLegacyPermissionFiles(legacyArchives);
  } catch (error) {
    try {
      restorePermissionFiles(snapshots);
    } catch (rollbackError) {
      error.message += `; additionally failed to restore permission files: ${rollbackError.message}`;
    }
    throw error;
  }
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
