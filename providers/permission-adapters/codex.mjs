import os from "node:os";
import path from "node:path";

function source(preset) {
  const rules = preset.rules.map(rule => `prefix_rule(\n    pattern = [${rule.command.map(JSON.stringify).join(", ")}],\n    decision = "allow",\n    justification = ${JSON.stringify(rule.justification)},\n)\n`);
  return [`# Agentgear permission preset: ${preset.name}\n# ${preset.description}\n`, ...rules].join("\n");
}

export const codexAdapter = {
  name: "codex",
  resolve({ scope, project, presetName, env }) {
    const home = path.resolve(env.HOME || os.homedir());
    const root = scope === "user"
      ? path.resolve(env.CODEX_HOME || path.join(home, ".codex"))
      : path.join(project, ".codex");
    const outputPath = path.join(root, "rules", `agentgear-preset-${presetName}.rules`);
    return { files: { rules: outputPath }, outputPath };
  },
  render({ preset, files }) {
    return [{ path: files.rules, source: source(preset) }];
  }
};
