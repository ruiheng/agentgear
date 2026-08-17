import os from "node:os";
import path from "node:path";
import { renderClaimedJsonPermissions } from "./shared.mjs";

export const claudeAdapter = {
  name: "claude",
  resolve({ scope, project, presetName, env }) {
    const base = scope === "user" ? path.resolve(env.HOME || os.homedir()) : project;
    const root = path.join(base, ".claude");
    const files = {
      settings: path.join(root, "settings.json"),
      manifest: path.join(root, `agentgear-preset-${presetName}.json`),
      registry: path.join(root, ".agentgear-permission-presets.json")
    };
    return { files, outputPath: files.settings };
  },
  render({ preset, files }) {
    const permissions = preset.rules.flatMap(rule => {
      const command = rule.command.join(" ");
      return [`Bash(${command})`, `Bash(${command} *)`];
    });
    return renderClaimedJsonPermissions({
      settingsPath: files.settings,
      claimPath: files.manifest,
      registryPath: files.registry,
      permissions,
      claimDocument: { version: 2, name: preset.name, producer: `preset:${preset.name}` }
    });
  }
};
