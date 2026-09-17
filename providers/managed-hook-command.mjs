import fs from "node:fs";
import path from "node:path";
import { isPlainObject, regularFile } from "./hook-json-file.mjs";

export const HOOK_TIMEOUT_SECONDS = 5;
const MANAGED_COMMAND_SUFFIX = " compact-memory-hook";

export function quotePosix(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function compactMemoryHookCommand(launcher, { platform = process.platform } = {}) {
  if (typeof launcher !== "string" || !launcher) throw new Error("Agentgear launcher path is required");
  const commandPosix = `${quotePosix(launcher)} compact-memory-hook`;
  return {
    launcher,
    command: platform === "win32" ? `node "${launcher}" compact-memory-hook` : commandPosix,
    commandPosix,
    commandWindows: `node ${quotePowerShellLiteral(launcher)} compact-memory-hook`
  };
}

export function compactMemoryLauncherUsable(launcher, { platform = process.platform } = {}) {
  if (!regularFile(launcher)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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

// Some host hook groups carry no description field, so a managed group is one
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

export function isManagedCompactMemoryGroup(group) {
  return isPlainObject(group)
    && Array.isArray(group.hooks)
    && group.hooks.length > 0
    && group.hooks.every(entry =>
      isPlainObject(entry) && entry.type === "command" && isManagedHookCommand(entry.command));
}

export function managedCompactMemoryGroupMatches(group, desired) {
  const candidateHook = Array.isArray(group?.hooks) && group.hooks.length === 1 ? group.hooks[0] : null;
  const desiredHook = desired.hooks[0];
  return candidateHook !== null
    && isManagedCompactMemoryGroup(group)
    && group.matcher === desired.matcher
    && candidateHook.command === desiredHook.command
    && candidateHook.timeout === desiredHook.timeout;
}
