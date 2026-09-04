import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESCRIPTION_PREFIX = "Agentgear Codex compact memory";
const MANAGED_DESCRIPTIONS = Object.freeze({
  SessionStart: `${DESCRIPTION_PREFIX} recovery`,
  PostToolUse: `${DESCRIPTION_PREFIX} capture`,
  Stop: `${DESCRIPTION_PREFIX} upstream recovery`
});
const HOOK_TIMEOUT_SECONDS = 5;
const RECOVERY_HOOK_TIMEOUT_SECONDS = 305;

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedDecimal(literal) {
  const match = literal.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const explicitExponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(explicitExponent)) return null;
  let exponent = explicitExponent - fraction.length;
  if (!Number.isSafeInteger(exponent)) return null;
  let coefficient = BigInt(`${match[2]}${fraction}`);
  if (match[1] === "-") coefficient = -coefficient;
  if (coefficient === 0n) return "0e0";
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1;
  }
  return `${coefficient}e${exponent}`;
}

function jsonNumberRoundTrips(literal) {
  const value = Number(literal);
  if (!Number.isFinite(value)) return false;
  return normalizedDecimal(literal) === normalizedDecimal(JSON.stringify(value));
}

function firstUnsafeJsonNumber(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== "-" && !/[0-9]/u.test(character)) continue;
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) continue;
    const literal = match[0];
    if (!jsonNumberRoundTrips(literal)) return literal;
    index += literal.length - 1;
  }
  return null;
}

function refuseUnsafeRewrite(filePath, literal) {
  if (!literal) return;
  const characters = Array.from(literal);
  const display = characters.length <= 80
    ? literal
    : `${characters.slice(0, 39).join("")}…${characters.slice(-40).join("")}`;
  throw new Error(`Cannot safely rewrite Codex hooks ${filePath}: JSON number ${display} cannot round-trip safely`);
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
    },
    Stop: {
      description: MANAGED_DESCRIPTIONS.Stop,
      hooks: [handler(commands, {
        timeout: RECOVERY_HOOK_TIMEOUT_SECONDS,
        statusMessage: "Waiting before recovering from upstream rate limit"
      })]
    }
  };
}

function readDocument(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return {
      value,
      mode: fs.statSync(filePath).mode & 0o777,
      unsafeNumber: firstUnsafeJsonNumber(text)
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, mode: 0o600, unsafeNumber: null };
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
    for (const [groupIndex, group] of groups.entries()) {
      if (!isPlainObject(group)) throw new Error(`Codex hooks.${event}[${groupIndex}] must be an object: ${filePath}`);
      if (group.matcher !== undefined && group.matcher !== null && typeof group.matcher !== "string") {
        throw new Error(`Codex hooks.${event}[${groupIndex}].matcher must be a string: ${filePath}`);
      }
      if (!Array.isArray(group.hooks)) {
        throw new Error(`Codex hooks.${event}[${groupIndex}].hooks must be an array: ${filePath}`);
      }
      for (const [handlerIndex, handlerValue] of group.hooks.entries()) {
        if (!isPlainObject(handlerValue)) {
          throw new Error(`Codex hooks.${event}[${groupIndex}].hooks[${handlerIndex}] must be an object: ${filePath}`);
        }
      }
    }
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

function hasManagedGroup(hooks) {
  return Object.entries(MANAGED_DESCRIPTIONS).some(([event, description]) =>
    (hooks[event] ?? []).some(group => group?.description === description));
}

function existingWritePath(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (info) return fs.realpathSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return filePath;
}

function writeDocument(filePath, value, mode) {
  const target = existingWritePath(filePath);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

export function installCodexCompactMemory({
  env = process.env,
  launcher,
  platform = process.platform,
  onlyIfInstalled = false
} = {}) {
  const filePath = path.join(codexHome(env), "hooks.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  if (onlyIfInstalled && !hasManagedGroup(hooks)) {
    return { path: filePath, changed: false, installed: false, launcher };
  }
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
  if (changed) {
    refuseUnsafeRewrite(filePath, unsafeNumber);
    writeDocument(filePath, next, mode);
  }
  return { path: filePath, changed, installed: true, command: commands.command, launcher };
}

export function uninstallCodexCompactMemory({ env = process.env } = {}) {
  const filePath = path.join(codexHome(env), "hooks.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
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
  if (changed) {
    refuseUnsafeRewrite(filePath, unsafeNumber);
    writeDocument(filePath, next, mode);
  }
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
