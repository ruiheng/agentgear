import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WAYPOST_CLI_ACTIONS = [
  { action: "read", stateScoped: true },
  { action: "list", stateScoped: true },
  { action: "fail", stateScoped: true },
  { action: "dead-letter", stateScoped: true },
  { action: "forward", stateScoped: true },
  { action: "wait", stateScoped: true },
  { action: "undefer", stateScoped: true },
  { action: "group", stateScoped: true },
  { action: "address", stateScoped: true },
  { action: "renew", stateScoped: true },
  { action: "doc", stateScoped: false }
];
const WAYPOST_CLI_ACTIONS_BY_NAME = new Map(WAYPOST_CLI_ACTIONS.map(item => [item.action, item]));
// At most two command forms, two state-directory forms, and exact/wildcard variants.
const MAX_WAYPOST_RULES = 2 * WAYPOST_CLI_ACTIONS.reduce(
  (count, item) => count + (item.stateScoped ? 4 : 2),
  0
);
const MANIFEST_VERSION = 4;
const WAYPOST_MCP_PERMISSION = /^mcp__waypost__[A-Za-z0-9_]+$/;
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

function quoteWindowsArgument(value) {
  if (/^[^\s"&|<>^()]+$/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

function run(command, args, { env } = {}) {
  const useCmd = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  if (useCmd) {
    if ([command, ...args].some(value => String(value).includes("%"))) {
      return {
        error: Object.assign(
          new Error("refusing to pass a percent-containing Waypost value through cmd.exe"),
          { code: "EINVAL" }
        ),
        status: null,
        stdout: "",
        stderr: ""
      };
    }
    const line = [command, ...args].map(quoteWindowsArgument).join(" ");
    return childProcess.spawnSync(env?.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], { env });
  }
  return childProcess.spawnSync(command, args, { env });
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
  if (existing) fs.chmodSync(temporary, existing.mode & 0o777);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function stableMcpPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length > 64) {
    throw new Error("invalid Waypost MCP ownership permission set");
  }
  if (!permissions.every(permission => typeof permission === "string" && WAYPOST_MCP_PERMISSION.test(permission))) {
    throw new Error("invalid Waypost MCP ownership permission");
  }
  if (new Set(permissions).size !== permissions.length) {
    throw new Error("Waypost MCP ownership permissions are not unique");
  }
  return permissions;
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

export function shellCommand(words) {
  return words.map(shellQuote).join(" ");
}

function commandAndStateForms(command, stateDir, home) {
  const commandForms = unique([command, tildePath(command, home)]);
  const stateForms = unique([stateDir, tildePath(stateDir, home)]);
  return { commandForms, stateForms };
}

function supportsWaypostCapabilities(command, stateDir, env) {
  const checks = [
    ["mcp", "--help"],
    ...WAYPOST_CLI_ACTIONS.map(item => item.stateScoped
      ? ["--state-dir", stateDir, item.action, "--help"]
      : [item.action, "--help"])
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
    return {
      trusted: false,
      rules: [],
      reason: `waypost lacks mcp/${WAYPOST_CLI_ACTIONS.map(item => item.action).join("/")} support`
    };
  }

  const { commandForms, stateForms } = commandAndStateForms(canonicalCommand, stateDir, home);
  const rules = [];
  for (const command of commandForms) {
    for (const item of WAYPOST_CLI_ACTIONS) {
      for (const ruleStateDir of item.stateScoped ? stateForms : [undefined]) {
        const baseRule = {
          command,
          ...(ruleStateDir === undefined ? {} : { stateDir: ruleStateDir }),
          action: item.action
        };
        rules.push(
          { ...baseRule, wildcard: false },
          { ...baseRule, wildcard: true }
        );
      }
    }
  }
  return { trusted: true, command: canonicalCommand, stateDir, rules };
}

function normalizedRule(rule) {
  const stateDir = rule?.stateDir ?? rule?.state_dir;
  if (!rule || hasUnsafeControlCharacters(rule.command)) {
    throw new Error("invalid Waypost ownership rule");
  }
  if (!(path.isAbsolute(rule.command) || rule.command.startsWith("~/"))) {
    throw new Error("Waypost ownership command must be absolute or home-relative");
  }
  if (!WAYPOST_EXECUTABLE.test(path.basename(rule.command))) {
    throw new Error("Waypost ownership command has an unsupported executable name");
  }
  if (typeof rule.wildcard !== "boolean") {
    throw new Error("invalid Waypost ownership rule action");
  }
  const actionSpec = WAYPOST_CLI_ACTIONS_BY_NAME.get(rule.action);
  if (!actionSpec) {
    throw new Error("invalid Waypost ownership rule action");
  }
  if (!actionSpec.stateScoped) {
    if (stateDir !== undefined && stateDir !== null) {
      throw new Error("global Waypost ownership rule must not include a state directory");
    }
    return { command: rule.command, action: rule.action, wildcard: rule.wildcard };
  }
  if (hasUnsafeControlCharacters(stateDir)
    || !(stateDir === "~" || path.isAbsolute(stateDir) || stateDir.startsWith("~/"))) {
    throw new Error("Waypost ownership state directory must be absolute or home-relative");
  }
  return { command: rule.command, stateDir, action: rule.action, wildcard: rule.wildcard };
}

export function claudeWaypostPermission(rule) {
  const normalized = normalizedRule(rule);
  const command = shellCommand([
    normalized.command,
    ...(normalized.stateDir === undefined ? [] : ["--state-dir", normalized.stateDir]),
    normalized.action
  ]);
  return `Bash(${command}${normalized.wildcard ? " *" : ""})`;
}

function stableRules(rules, { allowGlobalActions = true } = {}) {
  const normalized = rules.map(normalizedRule);
  if (!allowGlobalActions && normalized.some(rule => rule.stateDir === undefined)) {
    throw new Error("invalid Waypost ownership rule action for manifest version");
  }
  const identities = normalized.map(rule => JSON.stringify(rule));
  if (normalized.length === 0
    || normalized.length > MAX_WAYPOST_RULES
    || new Set(identities).size !== normalized.length) {
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

export function ownershipManifestPath(configRoot) {
  return path.join(configRoot, ".claude", ".agentgear-workflow-permissions.json");
}

export function legacyOwnershipManifestPath(configRoot) {
  return path.join(configRoot, ".claude", ".agent-deck-workflow-waypost-cli.json");
}

export function readWaypostOwnershipManifest(configRoot) {
  const currentPath = ownershipManifestPath(configRoot);
  const legacyPath = legacyOwnershipManifestPath(configRoot);
  const manifestPath = safeLstat(currentPath) ? currentPath : legacyPath;
  const info = safeLstat(manifestPath);
  if (!info) return { present: false, version: 0, permissions: [], mcpPermissions: [] };
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
    return { present: true, version: 1, permissions: manifest.permissions, rules: [], mcpPermissions: [], manifestPath };
  }
  if (![2, 3, MANIFEST_VERSION].includes(manifest.version) || !Array.isArray(manifest.rules)) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  const rules = stableRules(manifest.rules, { allowGlobalActions: manifest.version === MANIFEST_VERSION });
  const permissions = permissionsForRules(rules);
  const storedPermissions = manifest.permissions;
  if (!storedPermissions.every(value => typeof value === "string") || storedPermissions.length !== permissions.length) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  if (storedPermissions.slice().sort().join("\0") !== permissions.slice().sort().join("\0")) {
    throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
  }
  const mcpPermissions = manifest.version === 2
    ? []
    : stableMcpPermissions(manifest.mcp_permissions);
  return { present: true, version: manifest.version, permissions, rules, mcpPermissions, manifestPath };
}

export function writeWaypostOwnershipManifest(configRoot, rules, mcpPermissions = []) {
  const normalizedRules = stableRules(rules);
  const permissions = permissionsForRules(normalizedRules);
  const normalizedMcpPermissions = stableMcpPermissions(mcpPermissions);
  const manifest = {
    version: MANIFEST_VERSION,
    permissions,
    mcp_permissions: normalizedMcpPermissions,
    rules: normalizedRules.map(rule => ({
      command: rule.command,
      ...(rule.stateDir === undefined ? {} : { state_dir: rule.stateDir }),
      action: rule.action,
      wildcard: rule.wildcard
    }))
  };
  const legacyPath = legacyOwnershipManifestPath(configRoot);
  const legacyInfo = safeLstat(legacyPath);
  if (legacyInfo && !isRegularFile(legacyPath)) {
    throw new Error(`refusing invalid legacy Claude Waypost ownership manifest: ${legacyPath}`);
  }
  const manifestPath = ownershipManifestPath(configRoot);
  writeAtomic(manifestPath, `${JSON.stringify(manifest)}\n`);
  if (legacyInfo) fs.rmSync(legacyPath);
  return { manifestPath, permissions };
}

export function removeWaypostOwnershipManifest(configRoot) {
  for (const manifestPath of [ownershipManifestPath(configRoot), legacyOwnershipManifestPath(configRoot)]) {
    const info = safeLstat(manifestPath);
    if (!info) continue;
    if (!isRegularFile(manifestPath)) {
      throw new Error(`refusing invalid Claude Waypost ownership manifest: ${manifestPath}`);
    }
    fs.rmSync(manifestPath);
  }
}

export function isLegacyBroadWaypostPermission(value) {
  return value === "Bash(waypost)" || value === "Bash(waypost *)";
}
