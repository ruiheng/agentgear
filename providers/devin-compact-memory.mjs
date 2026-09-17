import path from "node:path";
import { devinConfigHome } from "../skills/multi-agent-protocol/scripts/devin-paths.mjs";
import { createCompactMemoryHost } from "./compact-memory-host.mjs";

const host = createCompactMemoryHost({
  label: "Devin config hooks",
  configPath: env => path.join(devinConfigHome(env), "config.json"),
  events: {
    SessionStart: { matcher: "" },
    // Devin executes PostCompaction hooks but ignores their
    // additionalContext, so the hook marks the session pending there and
    // delivers restoration through the next PostToolUse or UserPromptSubmit
    // event. PostToolUse therefore matches every tool, not only the ones that
    // record memory.
    PostCompaction: { matcher: "" },
    PostToolUse: { matcher: "" },
    UserPromptSubmit: { matcher: "" }
  }
});

export const installDevinCompactMemory = host.install;
export const uninstallDevinCompactMemory = host.uninstall;
export const doctorDevinCompactMemory = host.doctor;
export const devinCompactMemoryLauncherUsable = host.launcherUsable;
