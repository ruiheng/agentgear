import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESCRIPTION_PREFIX = "Agentgear Codex compact memory";
const MANAGED_DESCRIPTIONS = Object.freeze({
  SessionStart: `${DESCRIPTION_PREFIX} recovery`,
  PostToolUse: `${DESCRIPTION_PREFIX} capture`
});
const HOOK_TIMEOUT_SECONDS = 5;

function codexHome(env) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) return path.resolve(env.CODEX_HOME);
  return path.join(env.HOME || os.homedir(), ".codex");
}

function quotePosix(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function hookCommands(launcher) {
  if (typeof launcher !== "string" || !launcher) throw new Error("Agentgear launcher path is required");
  return {
    launcher,
    command: `${quotePosix(launcher)} compact-memory-hook`,
    commandWindows: `node ${quotePowerShellLiteral(launcher)} compact-memory-hook`
  };
}

function regularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function codexCompactMemoryLauncherUsable(launcher, { platform = process.platform } = {}) {
  if (!regularFile(launcher)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function handler(commands, extra = {}) {
  return {
    type: "command",
    command: commands.command,
    commandWindows: commands.commandWindows,
    async: false,
    timeout: HOOK_TIMEOUT_SECONDS,
    ...extra
  };
}

function desiredGroups(commands) {
  return {
    SessionStart: {
      description: MANAGED_DESCRIPTIONS.SessionStart,
      matcher: "^compact$",
      hooks: [handler(commands, {
        statusMessage: "Restoring Agentgear compact memory",
        additionalContextLimit: 8000
      })]
    },
    PostToolUse: {
      description: MANAGED_DESCRIPTIONS.PostToolUse,
      matcher: "^(?:Bash|mcp__waypost__waypost_(?:recv|read)|waypost_(?:recv|read))$",
      hooks: [handler(commands)]
    }
  };
}

function readDocument(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return { value, mode: fs.statSync(filePath).mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, mode: 0o600 };
    throw new Error(`Cannot read Codex hooks ${filePath}: ${error.message}`);
  }
}

function validateHooks(value, filePath) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex hooks field must be an object: ${filePath}`);
  }
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) throw new Error(`Codex hooks.${event} must be an array: ${filePath}`);
  }
  return value;
}

function mergeManagedGroup(groups, desired) {
  const updated = [];
  let inserted = false;
  for (const group of groups) {
    if (group?.description === desired.description) {
      if (!inserted) updated.push(desired);
      inserted = true;
    } else {
      updated.push(group);
    }
  }
  if (!inserted) updated.push(desired);
  return updated;
}

function existingWritePath(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (info) return fs.realpathSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return filePath;
}

function writeDocument(filePath, value, mode) {
  const target = existingWritePath(filePath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, target);
}

export function installCodexCompactMemory({ env = process.env, launcher, platform = process.platform } = {}) {
  const filePath = path.join(codexHome(env), "hooks.json");
  const { value, mode } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const commands = hookCommands(launcher);
  if (!codexCompactMemoryLauncherUsable(launcher, { platform })) {
    throw new Error(`Agentgear launcher is not usable: ${launcher}`);
  }
  const desired = desiredGroups(commands);
  const updated = { ...hooks };
  for (const [event, group] of Object.entries(desired)) {
    updated[event] = mergeManagedGroup(hooks[event] ?? [], group);
  }
  const next = { ...value, hooks: updated };
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) writeDocument(filePath, next, mode);
  return { path: filePath, changed, command: commands.command, launcher };
}

export function uninstallCodexCompactMemory({ env = process.env } = {}) {
  const filePath = path.join(codexHome(env), "hooks.json");
  const { value, mode } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const updated = { ...hooks };
  for (const [event, description] of Object.entries(MANAGED_DESCRIPTIONS)) {
    if (!Array.isArray(updated[event])) continue;
    const remaining = updated[event].filter(group => group?.description !== description);
    if (remaining.length > 0) updated[event] = remaining;
    else delete updated[event];
  }
  const next = Object.keys(updated).length > 0
    ? { ...value, hooks: updated }
    : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hooks"));
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) writeDocument(filePath, next, mode);
  return { path: filePath, changed };
}

function groupMatches(group, desired) {
  const candidateHook = Array.isArray(group?.hooks) && group.hooks.length === 1 ? group.hooks[0] : null;
  const desiredHook = desired.hooks[0];
  return group?.description === desired.description
    && group.matcher === desired.matcher
    && candidateHook?.type === "command"
    && candidateHook.command === desiredHook.command
    && candidateHook.commandWindows === desiredHook.commandWindows
    && candidateHook.async === desiredHook.async
    && candidateHook.timeout === desiredHook.timeout
    && candidateHook.statusMessage === desiredHook.statusMessage
    && candidateHook.additionalContextLimit === desiredHook.additionalContextLimit;
}

export function doctorCodexCompactMemory({ env = process.env, launcher, platform = process.platform } = {}) {
  const filePath = path.join(codexHome(env), "hooks.json");
  const { value } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const commands = hookCommands(launcher);
  const desired = desiredGroups(commands);
  const missing = [];
  for (const [event, group] of Object.entries(desired)) {
    const managed = (hooks[event] ?? []).filter(candidate => candidate?.description === group.description);
    if (managed.length !== 1 || !groupMatches(managed[0], group)) missing.push(event);
  }
  return {
    path: filePath,
    command: commands.command,
    missing,
    launcherUsable: codexCompactMemoryLauncherUsable(launcher, { platform })
  };
}
