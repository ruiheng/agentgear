import process from "node:process";
import {
  doctorCodexCompactMemory,
  installCodexCompactMemory,
  uninstallCodexCompactMemory
} from "../../providers/codex-compact-memory.mjs";
import {
  doctorDevinCompactMemory,
  installDevinCompactMemory,
  uninstallDevinCompactMemory
} from "../../providers/devin-compact-memory.mjs";
import { computePaths } from "./runtime.mjs";

export const managedHookHosts = Object.freeze([
  Object.freeze({
    name: "codex",
    label: "Codex",
    install: installCodexCompactMemory,
    uninstall: uninstallCodexCompactMemory,
    doctor: doctorCodexCompactMemory
  }),
  Object.freeze({
    name: "devin",
    label: "Devin",
    install: installDevinCompactMemory,
    uninstall: uninstallDevinCompactMemory,
    doctor: doctorDevinCompactMemory
  })
]);

export function resolveHookHosts(targets = []) {
  if (targets.length === 0) return [...managedHookHosts];
  const selected = targets.map(name => managedHookHosts.find(host => host.name === name));
  const unknown = targets.filter((name, index) => !selected[index]);
  if (unknown.length > 0 || new Set(targets).size !== targets.length) {
    throw new Error(
      `Unknown hook target(s): ${unknown.join(",") || "duplicate"}; use ${managedHookHosts.map(host => host.name).join(",")}`
    );
  }
  return selected;
}

export function refreshInstalledManagedHooks({ env = process.env, print = () => {} } = {}) {
  for (const host of managedHookHosts) {
    try {
      const result = host.install({
        env,
        launcher: computePaths(env).launcher,
        onlyIfInstalled: true
      });
      if (result.installed && result.changed) {
        print(`refreshed Agentgear ${host.label} hooks: ${result.path}`);
      }
    } catch (error) {
      print(`Warning: Agentgear ${host.label} hooks were not refreshed: ${error.message}`);
    }
  }
}

export function uninstallManagedHooks({ env = process.env, print = () => {} } = {}) {
  for (const host of managedHookHosts) host.uninstall({ env, dryRun: true });
  for (const host of managedHookHosts) {
    const result = host.uninstall({ env });
    if (result.changed) print(`unregistered Agentgear ${host.label} hooks: ${result.path}`);
  }
}
