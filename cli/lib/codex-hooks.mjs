import process from "node:process";
import { installCodexCompactMemory } from "../../providers/codex-compact-memory.mjs";
import { computePaths } from "./runtime.mjs";

export function refreshInstalledCodexHooks({ env = process.env, print = () => {} } = {}) {
  try {
    const result = installCodexCompactMemory({
      env,
      launcher: computePaths(env).launcher,
      onlyIfInstalled: true
    });
    if (result.installed && result.changed) {
      print(`refreshed Agentgear Codex hooks: ${result.path}`);
    }
    return result;
  } catch (error) {
    print(`Warning: Agentgear Codex hooks were not refreshed: ${error.message}`);
    return { changed: false, installed: null, error };
  }
}
