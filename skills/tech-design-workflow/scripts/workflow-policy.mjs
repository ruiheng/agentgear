import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WORKFLOW_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/workflow-policy.toml"
);

export function resolveWorkflowPolicyPaths({
  env = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
  defaultPath = DEFAULT_WORKFLOW_POLICY_PATH
} = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return [
    path.resolve(defaultPath),
    path.resolve(configHome, "agentgear", "workflow-policy.local.toml"),
    path.resolve(cwd, "workflow-policy.local.toml")
  ];
}

export function parseWorkflowPolicyToml(source, label = "workflow policy") {
  const policy = {};
  let section = "";
  for (const [index, original] of source.split(/\r?\n/).entries()) {
    const line = original.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (section !== "tech_design.pruner") {
        throw new Error(`${label}: unsupported section on line ${index + 1}: ${section}`);
      }
      continue;
    }
    if (section !== "tech_design.pruner") {
      throw new Error(`${label}: assignment outside [tech_design.pruner] on line ${index + 1}`);
    }
    const assignment = /^(max_lines|max_chars|recheck_added_lines|recheck_added_chars)\s*=\s*([0-9]+)$/.exec(line);
    if (!assignment) throw new Error(`${label}: invalid assignment on line ${index + 1}`);
    const value = Number(assignment[2]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label}: ${assignment[1]} must be a positive integer`);
    }
    policy[assignment[1]] = value;
  }
  return policy;
}

export function loadWorkflowPolicy({ paths, ...pathOptions } = {}) {
  const resolvedPaths = paths ?? resolveWorkflowPolicyPaths(pathOptions);
  let policy = {};
  let loaded = 0;
  for (const filePath of resolvedPaths) {
    const info = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isFile()) throw new Error(`workflow policy is not a file: ${filePath}`);
    policy = { ...policy, ...parseWorkflowPolicyToml(fs.readFileSync(filePath, "utf8"), filePath) };
    loaded += 1;
  }
  if (loaded === 0) throw new Error("no workflow policy file was found");
  for (const key of ["max_lines", "max_chars", "recheck_added_lines", "recheck_added_chars"]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) {
      throw new Error(`workflow policy is missing tech_design.pruner.${key}`);
    }
  }
  return Object.freeze({
    maxLines: policy.max_lines,
    maxChars: policy.max_chars,
    recheckAddedLines: policy.recheck_added_lines,
    recheckAddedChars: policy.recheck_added_chars
  });
}
