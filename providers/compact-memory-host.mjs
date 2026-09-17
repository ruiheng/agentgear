import {
  isPlainObject,
  readHookDocument,
  refuseUnsafeRewrite,
  validateHookGroups,
  writeHookDocument
} from "./hook-json-file.mjs";
import {
  HOOK_TIMEOUT_SECONDS,
  compactMemoryHookCommand,
  compactMemoryLauncherUsable,
  isManagedCompactMemoryGroup,
  managedCompactMemoryGroupMatches
} from "./managed-hook-command.mjs";

// One install/uninstall/doctor pipeline for every compact-memory host. The
// per-host spec supplies only what genuinely varies: the config file path,
// the event -> hook-group table, and how managed groups are identified.
//
// Group identity has two flavors:
// - command-keyed hosts (Claude settings.json, Devin config.json) carry no
//   group labels, so managed groups are recognized by their launcher command.
// - description-keyed hosts (Codex hooks.json) label each managed group with
//   a description field instead.
export function createCompactMemoryHost({
  label,
  configPath,
  events,
  descriptionKeyed = false
}) {
  const eventNames = Object.keys(events);

  function handler(commands, definition) {
    const entry = {
      type: "command",
      command: definition.windowsCommand ? commands.commandPosix : commands.command
    };
    if (definition.windowsCommand) {
      entry.commandWindows = commands.commandWindows;
      entry.async = false;
    }
    entry.timeout = HOOK_TIMEOUT_SECONDS;
    return { ...entry, ...definition.handlerExtra };
  }

  function desiredGroups(commands) {
    return Object.fromEntries(Object.entries(events).map(([event, definition]) => [event, {
      ...(definition.description === undefined ? {} : { description: definition.description }),
      matcher: definition.matcher,
      hooks: [handler(commands, definition)]
    }]));
  }

  function isManagedGroup(group, event) {
    return descriptionKeyed
      ? isPlainObject(group) && group.description === events[event].description
      : isManagedCompactMemoryGroup(group);
  }

  function hasManaged(hooks) {
    return eventNames.some(event =>
      Array.isArray(hooks[event]) && hooks[event].some(group => isManagedGroup(group, event)));
  }

  function mergeManagedGroup(groups, desired, event) {
    const updated = [];
    let inserted = false;
    for (const group of groups) {
      if (isManagedGroup(group, event)) {
        if (!inserted) updated.push(desired);
        inserted = true;
      } else {
        updated.push(group);
      }
    }
    if (!inserted) updated.push(desired);
    return updated;
  }

  function groupMatches(group, desired, event) {
    if (!descriptionKeyed) return managedCompactMemoryGroupMatches(group, desired);
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

  function install({
    env = process.env,
    launcher,
    platform = process.platform,
    onlyIfInstalled = false,
    dryRun = false
  } = {}) {
    const filePath = configPath(env);
    const { value, mode, unsafeNumber } = readHookDocument(filePath, label);
    const hooks = validateHookGroups(value.hooks, filePath, label);
    if (onlyIfInstalled && !hasManaged(hooks)) {
      return { path: filePath, changed: false, installed: false, launcher };
    }
    const commands = compactMemoryHookCommand(launcher, { platform });
    if (!compactMemoryLauncherUsable(launcher, { platform })) {
      throw new Error(`Agentgear launcher is not usable: ${launcher}`);
    }
    const desired = desiredGroups(commands);
    const updated = { ...hooks };
    for (const [event, group] of Object.entries(desired)) {
      updated[event] = mergeManagedGroup(hooks[event] ?? [], group, event);
    }
    const next = { ...value, hooks: updated };
    const changed = JSON.stringify(next) !== JSON.stringify(value);
    if (changed) {
      refuseUnsafeRewrite(filePath, unsafeNumber, label);
      if (!dryRun) writeHookDocument(filePath, next, mode);
    }
    return { path: filePath, changed, installed: true, command: commands.command, launcher };
  }

  function uninstall({ env = process.env, dryRun = false } = {}) {
    const filePath = configPath(env);
    const { value, mode, unsafeNumber } = readHookDocument(filePath, label);
    const hooks = validateHookGroups(value.hooks, filePath, label);
    const updated = { ...hooks };
    // Command-keyed hosts scan every event so that managed groups stranded
    // under unrelated events are still removed; description-keyed hosts only
    // scan their own managed events.
    const scanEvents = descriptionKeyed ? eventNames : Object.keys(updated);
    for (const event of scanEvents) {
      if (!Array.isArray(updated[event])) continue;
      const remaining = updated[event].filter(group => !isManagedGroup(group, event));
      if (remaining.length > 0) updated[event] = remaining;
      else delete updated[event];
    }
    const next = Object.keys(updated).length > 0
      ? { ...value, hooks: updated }
      : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hooks"));
    const changed = JSON.stringify(next) !== JSON.stringify(value);
    if (changed) {
      refuseUnsafeRewrite(filePath, unsafeNumber, label);
      if (!dryRun) writeHookDocument(filePath, next, mode);
    }
    return { path: filePath, changed };
  }

  function doctor({ env = process.env, launcher, platform = process.platform } = {}) {
    const filePath = configPath(env);
    const { value } = readHookDocument(filePath, label);
    const hooks = validateHookGroups(value.hooks, filePath, label);
    const commands = compactMemoryHookCommand(launcher, { platform });
    const desired = desiredGroups(commands);
    const missing = [];
    for (const [event, group] of Object.entries(desired)) {
      const managed = (hooks[event] ?? []).filter(candidate => isManagedGroup(candidate, event));
      if (managed.length !== 1 || !groupMatches(managed[0], group, event)) missing.push(event);
    }
    return {
      path: filePath,
      command: commands.command,
      missing,
      launcherUsable: compactMemoryLauncherUsable(launcher, { platform })
    };
  }

  return {
    install,
    uninstall,
    doctor,
    launcherUsable: (launcher, { platform = process.platform } = {}) =>
      compactMemoryLauncherUsable(launcher, { platform })
  };
}
