import os from "node:os";
import path from "node:path";

function source(preset) {
  const rules = preset.rules.map((rule, index) => `[[rule]]\nname = ${JSON.stringify(`allow_${preset.name.replaceAll("-", "_")}_${index + 1}`)}\nenabled = true\ndecision = "allow"\ntoolName = "run_shell_command"\ncommandPrefix = [${rule.command.map(JSON.stringify).join(", ")}]\npriority = 900\nmodes = ["default", "autoEdit", "yolo"]\n`);
  return [`# Agentgear permission preset: ${preset.name}\n# ${preset.description}\n`, ...rules].join("\n");
}

export const geminiAdapter = {
  name: "gemini",
  resolve({ scope, project, presetName, env }) {
    const base = scope === "user" ? path.resolve(env.HOME || os.homedir()) : project;
    const outputPath = path.join(base, ".gemini", "policies", `agentgear-preset-${presetName}.toml`);
    return { files: { policy: outputPath }, outputPath };
  },
  render({ preset, files }) {
    return [{ path: files.policy, source: source(preset) }];
  }
};
