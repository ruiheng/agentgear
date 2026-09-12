import fs from "node:fs";
import path from "node:path";
import { devinConfigHome } from "../skills/multi-agent-protocol/scripts/devin-paths.mjs";
import {
  isPlainObject,
  readHookDocument,
  refuseUnsafeRewrite,
  regularFile,
  validateHookGroups,
  writeHookDocument
} from "./hook-json-file.mjs";

const LABEL = "Devin config hooks";
const HOOK_TIMEOUT_SECONDS = 5;
const MANAGED_EVENTS = Object.freeze(["SessionStart", "PostCompaction", "PostToolUse"]);

function quotePosix(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookCommands(launcher, { platform = process.platform } = {}) {
  if (typeof launcher !== "string" || !launcher) throw new Error("Agentgear launcher path is required");
  return {
    launcher,
    command: platform === "win32"
      ? `node "${launcher}" compact-memory-hook`
      : `${quotePosix(launcher)} compact-memory-hook`
  };
}

export function devinCompactMemoryLauncherUsable(launcher, { platform = process.platform } = {}) {
  if (!regularFile(launcher)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function handler(commands) {
  return {
    type: "command",
    command: commands.command,
    timeout: HOOK_TIMEOUT_SECONDS
  };
}

function desiredGroups(commands) {
  return {
    SessionStart: {
      matcher: "",
      hooks: [handler(commands)]
    },
    PostCompaction: {
      matcher: "",
      hooks: [handler(commands)]
    },
    PostToolUse: {
      matcher: "^(?:exec|mcp__waypost__waypost_(?:recv|read))$",
      hooks: [handler(commands)]
    }
  };
}

const MANAGED_COMMAND_SUFFIX = " compact-memory-hook";

function unquotePosixCommand(text) {
  if (!text.startsWith("'") || !text.endsWith("'")) return null;
  const parts = text.slice(1, -1).split(`'"'"'`);
  return parts.some(part => part.includes("'")) ? null : parts.join("'");
}

function managedCommandLauncher(command) {
  if (typeof command !== "string") return null;
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith(MANAGED_COMMAND_SUFFIX)) return null;
  const head = trimmed.slice(0, -MANAGED_COMMAND_SUFFIX.length);
  const unquoted = unquotePosixCommand(head);
  if (unquoted !== null) return unquoted;
  const nodeCommand = /^node "([^"]+)"$/.exec(head);
  return nodeCommand ? nodeCommand[1] : null;
}

// Devin hook groups carry no description field, so a managed group is one
// whose hooks consist solely of the exact Agentgear compact-memory command:
// a quoted absolute launcher path whose basename is "agentgear".
function isManagedHookCommand(command) {
  const launcher = managedCommandLauncher(command);
  if (launcher === null) return false;
  const absolute = path.isAbsolute(launcher)
    || /^[A-Za-z]:[\\/]/.test(launcher)
    || launcher.startsWith("\\\\");
  return absolute && launcher.split(/[\\/]/).pop() === "agentgear";
}

function isManagedGroup(group) {
  return isPlainObject(group)
    && Array.isArray(group.hooks)
    && group.hooks.length > 0
    && group.hooks.every(entry =>
      isPlainObject(entry) && entry.type === "command" && isManagedHookCommand(entry.command));
}

function readDocument(filePath) {
  return readHookDocument(filePath, LABEL);
}

function validateHooks(value, filePath) {
  return validateHookGroups(value, filePath, LABEL);
}

function mergeManagedGroup(groups, desired) {
  const updated = [];
  let inserted = false;
  for (const group of groups) {
    if (isManagedGroup(group)) {
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
  return MANAGED_EVENTS.some(event => (hooks[event] ?? []).some(isManagedGroup));
}

export function installDevinCompactMemory({
  env = process.env,
  launcher,
  platform = process.platform,
  onlyIfInstalled = false,
  dryRun = false
} = {}) {
  const filePath = path.join(devinConfigHome(env), "config.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  if (onlyIfInstalled && !hasManagedGroup(hooks)) {
    return { path: filePath, changed: false, installed: false, launcher };
  }
  const commands = hookCommands(launcher, { platform });
  if (!devinCompactMemoryLauncherUsable(launcher, { platform })) {
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
    refuseUnsafeRewrite(filePath, unsafeNumber, LABEL);
    if (!dryRun) writeHookDocument(filePath, next, mode);
  }
  return { path: filePath, changed, installed: true, command: commands.command, launcher };
}

export function uninstallDevinCompactMemory({ env = process.env, dryRun = false } = {}) {
  const filePath = path.join(devinConfigHome(env), "config.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const updated = { ...hooks };
  for (const event of Object.keys(updated)) {
    if (!Array.isArray(updated[event])) continue;
    const remaining = updated[event].filter(group => !isManagedGroup(group));
    if (remaining.length > 0) updated[event] = remaining;
    else delete updated[event];
  }
  const next = Object.keys(updated).length > 0
    ? { ...value, hooks: updated }
    : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hooks"));
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) {
    refuseUnsafeRewrite(filePath, unsafeNumber, LABEL);
    if (!dryRun) writeHookDocument(filePath, next, mode);
  }
  return { path: filePath, changed };
}

function groupMatches(group, desired) {
  const candidateHook = Array.isArray(group?.hooks) && group.hooks.length === 1 ? group.hooks[0] : null;
  const desiredHook = desired.hooks[0];
  return isManagedGroup(group)
    && group.matcher === desired.matcher
    && candidateHook.command === desiredHook.command
    && candidateHook.timeout === desiredHook.timeout;
}

export function doctorDevinCompactMemory({ env = process.env, launcher, platform = process.platform } = {}) {
  const filePath = path.join(devinConfigHome(env), "config.json");
  const { value } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const commands = hookCommands(launcher, { platform });
  const desired = desiredGroups(commands);
  const missing = [];
  for (const [event, group] of Object.entries(desired)) {
    const managed = (hooks[event] ?? []).filter(isManagedGroup);
    if (managed.length !== 1 || !groupMatches(managed[0], group)) missing.push(event);
  }
  return {
    path: filePath,
    command: commands.command,
    missing,
    launcherUsable: devinCompactMemoryLauncherUsable(launcher, { platform })
  };
}
