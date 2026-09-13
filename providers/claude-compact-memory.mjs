import os from "node:os";
import path from "node:path";
import {
  readHookDocument,
  refuseUnsafeRewrite,
  validateHookGroups,
  writeHookDocument
} from "./hook-json-file.mjs";
import {
  compactMemoryHandler,
  compactMemoryHookCommand,
  compactMemoryLauncherUsable,
  hasManagedCompactMemoryGroup,
  isManagedCompactMemoryGroup,
  managedCompactMemoryGroupMatches,
  mergeManagedCompactMemoryGroup
} from "./managed-hook-command.mjs";

const LABEL = "Claude Code settings hooks";
const MANAGED_EVENTS = Object.freeze(["SessionStart", "PostToolUse"]);

function claudeConfigHome(env) {
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()) {
    return path.resolve(env.CLAUDE_CONFIG_DIR);
  }
  return path.join(env.HOME || os.homedir(), ".claude");
}

export function claudeCompactMemoryLauncherUsable(launcher, { platform = process.platform } = {}) {
  return compactMemoryLauncherUsable(launcher, { platform });
}

function desiredGroups(commands) {
  return {
    SessionStart: {
      matcher: "^compact$",
      hooks: [compactMemoryHandler(commands)]
    },
    PostToolUse: {
      matcher: "^(?:Bash|mcp__waypost__waypost_(?:recv|read)|waypost_(?:recv|read))$",
      hooks: [compactMemoryHandler(commands)]
    }
  };
}

function readDocument(filePath) {
  return readHookDocument(filePath, LABEL);
}

function validateHooks(value, filePath) {
  return validateHookGroups(value, filePath, LABEL);
}

export function installClaudeCompactMemory({
  env = process.env,
  launcher,
  platform = process.platform,
  onlyIfInstalled = false,
  dryRun = false
} = {}) {
  const filePath = path.join(claudeConfigHome(env), "settings.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  if (onlyIfInstalled && !hasManagedCompactMemoryGroup(hooks, MANAGED_EVENTS)) {
    return { path: filePath, changed: false, installed: false, launcher };
  }
  const commands = compactMemoryHookCommand(launcher, { platform });
  if (!claudeCompactMemoryLauncherUsable(launcher, { platform })) {
    throw new Error(`Agentgear launcher is not usable: ${launcher}`);
  }
  const desired = desiredGroups(commands);
  const updated = { ...hooks };
  for (const [event, group] of Object.entries(desired)) {
    updated[event] = mergeManagedCompactMemoryGroup(hooks[event] ?? [], group);
  }
  const next = { ...value, hooks: updated };
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) {
    refuseUnsafeRewrite(filePath, unsafeNumber, LABEL);
    if (!dryRun) writeHookDocument(filePath, next, mode);
  }
  return { path: filePath, changed, installed: true, command: commands.command, launcher };
}

export function uninstallClaudeCompactMemory({ env = process.env, dryRun = false } = {}) {
  const filePath = path.join(claudeConfigHome(env), "settings.json");
  const { value, mode, unsafeNumber } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const updated = { ...hooks };
  for (const event of Object.keys(updated)) {
    if (!Array.isArray(updated[event])) continue;
    const remaining = updated[event].filter(group => !isManagedCompactMemoryGroup(group));
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

export function doctorClaudeCompactMemory({ env = process.env, launcher, platform = process.platform } = {}) {
  const filePath = path.join(claudeConfigHome(env), "settings.json");
  const { value } = readDocument(filePath);
  const hooks = validateHooks(value.hooks, filePath);
  const commands = compactMemoryHookCommand(launcher, { platform });
  const desired = desiredGroups(commands);
  const missing = [];
  for (const [event, group] of Object.entries(desired)) {
    const managed = (hooks[event] ?? []).filter(isManagedCompactMemoryGroup);
    if (managed.length !== 1 || !managedCompactMemoryGroupMatches(managed[0], group)) missing.push(event);
  }
  return {
    path: filePath,
    command: commands.command,
    missing,
    launcherUsable: claudeCompactMemoryLauncherUsable(launcher, { platform })
  };
}
