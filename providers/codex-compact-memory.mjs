import os from "node:os";
import path from "node:path";
import { createCompactMemoryHost } from "./compact-memory-host.mjs";

function codexHome(env) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) return path.resolve(env.CODEX_HOME);
  return path.join(env.HOME || os.homedir(), ".codex");
}

const host = createCompactMemoryHost({
  label: "Codex hooks",
  configPath: env => path.join(codexHome(env), "hooks.json"),
  descriptionKeyed: true,
  events: {
    SessionStart: {
      description: "Agentgear Codex compact memory recovery",
      matcher: "^compact$",
      windowsCommand: true,
      handlerExtra: {
        statusMessage: "Restoring Agentgear compact memory",
        additionalContextLimit: 8000
      }
    },
    PostToolUse: {
      description: "Agentgear Codex compact memory capture",
      matcher: "^(?:Bash|mcp__waypost__waypost_(?:recv|read)|waypost_(?:recv|read))$",
      windowsCommand: true
    }
  }
});

export const installCodexCompactMemory = host.install;
export const uninstallCodexCompactMemory = host.uninstall;
export const doctorCodexCompactMemory = host.doctor;
export const codexCompactMemoryLauncherUsable = host.launcherUsable;
