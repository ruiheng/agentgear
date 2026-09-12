import path from "node:path";
import { shellCommand } from "../../skills/multi-agent-protocol/scripts/waypost-permission-spec.mjs";
import { devinConfigHome } from "../../skills/multi-agent-protocol/scripts/devin-paths.mjs";
import { renderClaimedJsonPermissions } from "./shared.mjs";

export const devinAdapter = {
  name: "devin",
  resolve({ scope, project, presetName, env }) {
    const root = scope === "user" ? devinConfigHome(env) : path.join(project, ".devin");
    const files = {
      settings: path.join(root, "config.json"),
      manifest: path.join(root, `agentgear-preset-${presetName}.json`),
      registry: path.join(root, ".agentgear-permission-presets.json")
    };
    return { files, outputPath: files.settings };
  },
  render({ preset, files }) {
    const permissions = preset.rules.map(rule => `Exec(${shellCommand(rule.command)})`);
    return renderClaimedJsonPermissions({
      settingsPath: files.settings,
      claimPath: files.manifest,
      registryPath: files.registry,
      permissions,
      claimDocument: { version: 2, name: preset.name, producer: `preset:${preset.name}` }
    });
  }
};
