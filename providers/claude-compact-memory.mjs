import os from "node:os";
import path from "node:path";
import { createCompactMemoryHost } from "./compact-memory-host.mjs";

function claudeConfigHome(env) {
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()) {
    return path.resolve(env.CLAUDE_CONFIG_DIR);
  }
  return path.join(env.HOME || os.homedir(), ".claude");
}

const host = createCompactMemoryHost({
  label: "Claude Code settings hooks",
  configPath: env => path.join(claudeConfigHome(env), "settings.json"),
  events: {
    SessionStart: { matcher: "^compact$" },
    PostToolUse: {
      matcher: "^(?:Bash|mcp__waypost__waypost_(?:recv|read)|waypost_(?:recv|read))$"
    }
  }
});

export const installClaudeCompactMemory = host.install;
export const uninstallClaudeCompactMemory = host.uninstall;
export const doctorClaudeCompactMemory = host.doctor;
export const claudeCompactMemoryLauncherUsable = host.launcherUsable;
