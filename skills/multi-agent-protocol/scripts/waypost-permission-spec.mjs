import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand, run } from "./workflow-lib.mjs";

const ACTIONS = ["read", "list"];
const MANIFEST_VERSION = 2;
const WAYPOST_EXECUTABLE = /^waypost(?:[._-].*)?$/;
const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const LEGACY_SAFE_PLAIN_SHELL_WORD = /^(?:[^\s\\$`"';&|()<>*?\[\]{}!#]|\\[^\r\n])(?:[^\s\\$`"';&|()<>*?\[\]{}!]|\\[^\r\n])*$/;
const LEGACY_SAFE_ANSI_C_CONTENT = /^(?:[^'\\\x00-\x1F\x7F]|\\[^\r\n])*$/;

function getHome(env = process.env) {
  return env.HOME || os.homedir();
}

function unique(values) {
  return [...new Set(values)];
}

function hasUnsafeControlCharacters(value) {
  return typeof value !== "string" || /[\0\r\n]/.test(value);
}

function safeLstat(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false });
}

function isRegularFile(filePath) {
  const info = safeLstat(filePath);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function isExecutableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && (fs.accessSync(filePath, fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

function writeAtomic(filePath, content) {
  const existing = safeLstat(filePath);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`refusing symlinked or non-file path: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function pathIsWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function tildePath(value, home = getHome()) {
  const normalizedHome = path.resolve(home);
  const normalizedValue = path.resolve(value);
  if (normalizedValue === normalizedHome) return "~";
  if (normalizedValue.startsWith(`${normalizedHome}${path.sep}`)) {
    return `~/${path.relative(normalizedHome, normalizedValue).split(path.sep).join("/")}`;
  }
  return normalizedValue;
}

export function shellQuote(value) {
  if (hasUnsafeControlCharacters(value)) throw new Error("permission path contains a control character");
  if (value === "~" || SAFE_SHELL_WORD.test(value)) return value;
  if (value.startsWith("~/")) {
    const suffix = value.slice(2);
    if (SAFE_SHELL_WORD.test(suffix)) return value;
    return `~/'${suffix.replaceAll("'", "'\\''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandAndStateForms(command, stateDir, home) {
  const commandForms = unique([command, tildePath(command, home)]);
  const stateForms = unique([stateDir, tildePath(stateDir, home)]);
  return { commandForms, stateForms };
}

function supportsWaypostCapabilities(command, stateDir, env) {
  const checks = [
    ["mcp", "--help"],
    ["--state-dir", stateDir, "read", "--help"],
    ["--state-dir", stateDir, "list", "--help"]
  ];
  return checks.every(args => run(command, args, { env }).status === 0);
}

export function resolveWaypostPermissionContext({
  projectDir,
  env = process.env,
  home = getHome(env)
} = {}) {
  const configuredStateDir = env.WAYPOST_STATE_DIR || path.join(
    env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    "ai-agent",
    "waypost"
  );
  if (!path.isAbsolute(configuredStateDir)) {
    return { trusted: false, rules: [], reason: "Waypost state directory must be absolute" };
  }
  const stateDir = path.resolve(configuredStateDir);
  if (hasUnsafeControlCharacters(stateDir)) {
    return { trusted: false, rules: [], reason: "Waypost state directory contains a control character" };
  }

  const resolved = resolveCommand("waypost", env);
  if (!resolved) {
    return { trusted: false, rules: [], reason: "waypost is not on PATH" };
  }
  if (!path.isAbsolute(resolved)) {
    return { trusted: false, rules: [], reason: "waypost resolved to a relative command" };
  }
  const commandPath = path.resolve(resolved);
  let canonicalCommand;
  try {
    canonicalCommand = fs.realpathSync(commandPath);
  } catch {
    return { trusted: false, rules: [], reason: "waypost does not resolve to an existing executable" };
  }
  if (!isExecutableFile(canonicalCommand)) {
    return { trusted: false, rules: [], reason: "waypost target is not an executable file" };
  }
  if (!WAYPOST_EXECUTABLE.test(path.basename(canonicalCommand))) {
    return { trusted: false, rules: [], reason: "waypost target has an unsupported executable name" };
  }

  let trustedProjectDir;
  if (projectDir) {
    try {
      trustedProjectDir = fs.realpathSync(projectDir);
    } catch {
      trustedProjectDir = path.resolve(projectDir);
    }
  }
  if (trustedProjectDir && (pathIsWithin(commandPath, trustedProjectDir) || pathIsWithin(canonicalCommand, trustedProjectDir))) {
    return { trusted: false, rules: [], reason: "waypost command or target is inside the project workspace" };
  }
  if (!supportsWaypostCapabilities(canonicalCommand, stateDir, env)) {
    return { trusted: false, rules: [], reason: "waypost lacks mcp/read/list support" };
  }

  const { commandForms, stateForms } = commandAndStateForms(canonicalCommand, stateDir, home);
  const rules = [];
  for (const command of commandForms) {
    for (const ruleStateDir of stateForms) {
      for (const action of ACTIONS) {
        rules.push(
          { command, stateDir: ruleStateDir, action, wildcard: false },
          { command, stateDir: ruleStateDir, action, wildcard: true }
        );
      }
    }
  }
  return { trusted: true, command: canonicalCommand, stateDir, rules };
}

function normalizedRule(rule) {
  const stateDir = rule?.stateDir ?? rule?.state_dir;
  if (!rule || hasUnsafeControlCharacters(rule.command) || hasUnsafeControlCharacters(stateDir)) {
    throw new Error("invalid Waypost ownership rule");
  }
  if (!(path.isAbsolute(rule.command) || rule.command.startsWith("~/"))) {
    throw new Error("Waypost ownership command must be absolute or home-relative");
  }
  if (!WAYPOST_EXECUTABLE.test(path.basename(rule.command))) {
    throw new Error("Waypost ownership command has an unsupported executable name");
  }
  if (!(stateDir === "~" || path.isAbsolute(stateDir) || stateDir.startsWith("~/"))) {
    throw new Error("Waypost ownership state directory must be absolute or home-relative");
  }
  if (!ACTIONS.includes(rule.action) || typeof rule.wildcard !== "boolean") {
    throw new Error("invalid Waypost ownership rule action");
  }
  return { command: rule.command, stateDir, action: rule.action, wildcard: rule.wildcard };
}

export function claudeWaypostPermission(rule) {
  const normalized = normalizedRule(rule);
  const command = [
    shellQuote(normalized.command),
    "--state-dir",
    shellQuote(normalized.stateDir),
    normalized.action
  ].join(" ");
  return `Bash(${command}${normalized.wildcard ? " *" : ""})`;
}

function stableRules(rules) {
  const normalized = rules.map(normalizedRule);
  const identities = normalized.map(rule => JSON.stringify(rule));
  if (normalized.length === 0 || normalized.length > 16 || new Set(identities).size !== normalized.length) {
    throw new Error("invalid Waypost ownership rule set");
  }
  return normalized;
}

function permissionsForRules(rules) {
  const permissions = rules.map(claudeWaypostPermission);
  if (new Set(permissions).size !== permissions.length) {
    throw new Error("Waypost ownership permissions are not unique");
  }
  return permissions;
}

function isSafeLegacyPlainShellWord(value) {
  return typeof value === "string" && LEGACY_SAFE_PLAIN_SHELL_WORD.test(value);
}

function isSafeLegacyAnsiCShellWord(value) {
  let content;
  if (value.startsWith("$'") && value.endsWith("'")) {
    content = value.slice(2, -1);
  } else if (value.startsWith("~/$'") && value.endsWith("'")) {
    content = value.slice(4, -1);
  } else {
    return false;
  }
  return LEGACY_SAFE_ANSI_C_CONTENT.test(content);
}

function isManagedLegacyCommand(value) {
  if (isSafeLegacyPlainShellWord(value)) {
    return (value.startsWith("/") || value.startsWith("~/")) && value.endsWith("/waypost");
  }
  if (isSafeLegacyAnsiCShellWord(value)) {
    return (value.startsWith("$'/") || value.startsWith("~/$'")) && value.endsWith("/waypost'");
  }
  return false;
}

function isManagedLegacyStateDir(value) {
  if (isSafeLegacyPlainShellWord(value)) {
    return value === "~" || value.startsWith("/") || value.startsWith("~/");
  }
  return isSafeLegacyAnsiCShellWord(value) && (value.startsWith("$'/") || value.startsWith("~/$'"));
}

function isLegacyV1Permission(value) {
  if (typeof value !== "string") return false;
  const match = /^Bash\((.+) --state-dir (.+) (read|list)(?: \*)?\)$/.exec(value);
  return Boolean(match && isManagedLegacyCommand(match[1]) && isManagedLegacyStateDir(match[2]));
}

export function ownershipManifestPath(projectDir) {
  return path.join(projectDir, ".claude", ".agent-deck-workflow-waypost-cli.json");
}

export function readWaypostOwnershipManifest(projectDir) {
  const manifestPath = ownershipManifestPath(projectDir);
  const info = safeLstat(manifestPath);
  if (!info) return { present: false, permissions: [] };
  if (!isRegularFile(manifestPath)) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`refusing malformed Claude Waypost ownership manifest: ${manifestPath}`);
  }
  if (!manifest || !Array.isArray(manifest.permissions)) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  // Version 1 contains only the rendered permissions. Accept only the
  // narrowly-scoped legacy grammar so one migration can remove the exact
  // installer-owned entries before replacing the manifest with v2 records.
  if (manifest.version === 1) {
    if (!manifest.permissions.every(isLegacyV1Permission)) {
      throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
    }
    return { present: true, permissions: manifest.permissions, rules: [] };
  }
  if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.rules)) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  const rules = stableRules(manifest.rules);
  const permissions = permissionsForRules(rules);
  const storedPermissions = manifest.permissions;
  if (!storedPermissions.every(value => typeof value === "string") || storedPermissions.length !== permissions.length) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  if (storedPermissions.slice().sort().join("\0") !== permissions.slice().sort().join("\0")) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  return { present: true, permissions, rules };
}

export function writeWaypostOwnershipManifest(projectDir, rules) {
  const normalizedRules = stableRules(rules);
  const permissions = permissionsForRules(normalizedRules);
  const manifest = {
    version: MANIFEST_VERSION,
    permissions,
    rules: normalizedRules.map(rule => ({
      command: rule.command,
      state_dir: rule.stateDir,
      action: rule.action,
      wildcard: rule.wildcard
    }))
  };
  const manifestPath = ownershipManifestPath(projectDir);
  writeAtomic(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { manifestPath, permissions };
}

export function isLegacyBroadWaypostPermission(value) {
  return value === "Bash(waypost)" || value === "Bash(waypost *)";
}
