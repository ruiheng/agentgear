import os from "node:os";
import path from "node:path";
import { renderClaimedJsonPermissions } from "./shared.mjs";

export const agyAdapter = {
  name: "agy",
  resolve({ scope, presetName, env }) {
    if (scope !== "user") {
      throw new Error("agy permission grants are user-scoped; use --scope user with --target agy");
    }
    const home = path.resolve(env.HOME || os.homedir());
    const root = path.resolve(env.AGENTGEAR_AGY_HOME || path.join(home, ".gemini", "antigravity-cli"));
    const files = {
      settings: path.join(root, "settings.json"),
      manifest: path.join(root, `agentgear-preset-${presetName}.json`),
      registry: path.join(root, ".agentgear-permission-presets.json")
    };
    return { files, outputPath: files.settings };
  },
  render({ preset, files }) {
    const permissions = preset.rules.map(rule => `command(${rule.command.join(" ")})`);
    return renderClaimedJsonPermissions({
      settingsPath: files.settings,
      claimPath: files.manifest,
      registryPath: files.registry,
      permissions,
      claimDocument: { version: 2, name: preset.name, producer: `preset:${preset.name}` }
    });
  }
};
