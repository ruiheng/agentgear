#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveAgentgearConfigDir(env = process.env, homeDir = os.homedir()) {
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.resolve(xdgConfigHome, "agentgear");
}

function resolveThurboxConfigDir(env = process.env, homeDir = os.homedir()) {
  const configuredDir = String(env.THURBOX_CONFIG_DIR || "").trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.resolve(xdgConfigHome, "thurbox");
}

function resolveThurboxAgentsConfigPath(env = process.env, homeDir = os.homedir()) {
  return path.join(resolveThurboxConfigDir(env, homeDir), "agents.toml");
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((configPath) => path.resolve(configPath)))];
}

function resolveCwdLocalConfigPath(cwd = process.cwd()) {
  return path.resolve(cwd, "tool-profiles.local.toml");
}

function resolveDefaultLocalConfigPaths(
  env = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd()
) {
  return uniquePaths([
    path.join(resolveAgentgearConfigDir(env, homeDir), "tool-profiles.local.toml"),
    resolveCwdLocalConfigPath(cwd),
  ]);
}

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/tool-profiles.toml");
const DEFAULT_LOCAL_CONFIG_PATH = path.join(resolveAgentgearConfigDir(), "tool-profiles.local.toml");
const DEFAULT_LOCAL_CONFIG_EXAMPLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/tool-profiles.local.example.toml"
);
const DEFAULT_LOCAL_CONFIG_PATHS = resolveDefaultLocalConfigPaths();

const ROLE_COMPATIBILITY_ALIASES = Object.freeze({
  architect_author: "architect",
  architect_reviewer: "architect",
});

const HELP_TEXT = `Usage: resolve-tool-command.js [options]

Resolve ordered launch candidates from an explicit command, profile, inherited command, or role default.

Options:
  --role <role>                  Resolve the profile configured for a role
  --profile <profile>            Resolve an explicit profile
  --command <command>            Use an explicit full command line
  --inherit-command <command>    Use an existing inherited full command line
  --show-list                    Include all usable tool candidates
  --list-roles                   List configured role names
  --workdir <path>               Inspect commands in the target workdir
  --target-path <PATH>           Inspect commands with the target PATH
  --config <path>                Use a specific tool-profiles.toml
  --local-config <path>          Apply a local tool profile override
  --init-local-config            Create the XDG user override from the bundled example
  --check-config                 Validate resolver configuration and Thurbox agent keys
  --format <json|text>           Select output format (default: json)
  --json                         Use JSON output
  -h, --help                     Show this help message
`;

function stripInlineComment(line) {
  let escaped = false;
  let stringQuote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped && stringQuote === "\"") {
      escaped = false;
      continue;
    }
    if (ch === "\\" && stringQuote === "\"") {
      escaped = true;
      continue;
    }
    if ((ch === "\"" || ch === "'") && !stringQuote) {
      stringQuote = ch;
      continue;
    }
    if (ch === stringQuote) {
      stringQuote = "";
      continue;
    }
    if (ch === "#" && !stringQuote) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countCharOutsideStrings(text, target) {
  let escaped = false;
  let stringQuote = "";
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped && stringQuote === "\"") {
      escaped = false;
      continue;
    }
    if (ch === "\\" && stringQuote === "\"") {
      escaped = true;
      continue;
    }
    if ((ch === "\"" || ch === "'") && !stringQuote) {
      stringQuote = ch;
      continue;
    }
    if (ch === stringQuote) {
      stringQuote = "";
      continue;
    }
    if (!stringQuote && ch === target) {
      count += 1;
    }
  }
  return count;
}

function parseSingleQuotedString(value) {
  if (!value.startsWith("'") || !value.endsWith("'")) {
    throw new Error(`invalid TOML literal string: ${value}`);
  }
  const inner = value.slice(1, -1);
  return inner.replace(/''/g, "'");
}

function splitTomlArrayItems(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const items = [];
  let current = "";
  let escaped = false;
  let stringQuote = "";
  let nestedDepth = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];

    if (stringQuote === "\"") {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        stringQuote = "";
      }
      continue;
    }

    if (stringQuote === "'") {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          stringQuote = "";
        }
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      stringQuote = ch;
      current += ch;
      continue;
    }

    if (ch === "[") {
      nestedDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      nestedDepth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && nestedDepth === 0) {
      const item = current.trim();
      if (item) {
        items.push(item);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    items.push(tail);
  }

  return items;
}

function parseTomlValue(rawValue) {
  const value = rawValue.trim();
  if (!value.length) {
    throw new Error("empty TOML value");
  }
  if (value.startsWith("\"")) {
    return JSON.parse(value);
  }
  if (value.startsWith("'")) {
    return parseSingleQuotedString(value);
  }
  if (value.startsWith("[")) {
    return splitTomlArrayItems(value).map((item) => parseTomlValue(item));
  }
  if (/^(true|false)$/.test(value)) {
    return value === "true";
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  throw new Error(`unsupported TOML value: ${value}`);
}

function ensureSectionTarget(config, sectionName) {
  if (sectionName === "roles") {
    config.roles ||= {};
    return config.roles;
  }
  if (sectionName === "templates") {
    config.templates ||= {};
    return config.templates;
  }
  if (sectionName.startsWith("profiles.")) {
    const profileName = sectionName.slice("profiles.".length).trim();
    if (!profileName) {
      throw new Error("profile section name is empty");
    }
    config.profiles ||= {};
    config.profiles[profileName] ||= {};
    return config.profiles[profileName];
  }
  throw new Error(`unsupported TOML section: ${sectionName}`);
}

function ensureCandidateArrayTarget(config, sectionName) {
  const prefix = "profiles.";
  const suffix = ".candidates";
  if (!sectionName.startsWith(prefix) || !sectionName.endsWith(suffix)) {
    throw new Error("unsupported TOML array table: " + sectionName);
  }

  const profileName = sectionName.slice(prefix.length, -suffix.length).trim();
  if (!profileName) {
    throw new Error("candidate profile name is empty");
  }

  config.profiles ||= {};
  const profile = (config.profiles[profileName] ||= {});
  if (profile.candidates === undefined) {
    profile.candidates = [];
  }
  if (!Array.isArray(profile.candidates)) {
    throw new Error("profile candidates cannot mix an array and array tables");
  }

  const candidate = {};
  profile.candidates.push(candidate);
  return candidate;
}

function parseToolProfilesToml(text) {
  const config = {
    version: null,
    roles: {},
    templates: {},
    profiles: {},
  };
  const lines = text.split(/\r?\n/);
  let currentTarget = config;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i]).trim();
    if (!line) {
      continue;
    }

    const arraySectionMatch = line.match(/^\[\[(.+)\]\]$/);
    if (arraySectionMatch) {
      currentTarget = ensureCandidateArrayTarget(
        config,
        arraySectionMatch[1].trim()
      );
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentTarget = ensureSectionTarget(config, sectionMatch[1].trim());
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`invalid TOML assignment on line ${i + 1}`);
    }

    const key = line.slice(0, eqIndex).trim();
    let rawValue = line.slice(eqIndex + 1).trim();

    if (countCharOutsideStrings(rawValue, "[") > countCharOutsideStrings(rawValue, "]")) {
      while (i + 1 < lines.length) {
        i += 1;
        rawValue += `\n${stripInlineComment(lines[i]).trim()}`;
        if (
          countCharOutsideStrings(rawValue, "[") ===
          countCharOutsideStrings(rawValue, "]")
        ) {
          break;
        }
      }
    }

    currentTarget[key] = parseTomlValue(rawValue);
  }

  return config;
}

const CANDIDATE_MERGE_MODES = new Set(["replace", "prepend", "append"]);

function mergeProfile(baseProfile = {}, overrideProfile = {}) {
  const baseCandidates = baseProfile.candidates;
  const baseFields = { ...baseProfile };
  delete baseFields.merge;
  delete baseFields.candidates;
  const {
    merge: candidateMerge,
    candidates: overrideCandidates,
    ...overrideFields
  } = overrideProfile;
  const merged = { ...baseFields, ...overrideFields };

  if (candidateMerge !== undefined && !CANDIDATE_MERGE_MODES.has(candidateMerge)) {
    throw new Error(`unsupported candidate merge mode: ${candidateMerge}`);
  }
  if (candidateMerge !== undefined && overrideCandidates === undefined) {
    throw new Error("candidate merge mode requires candidates");
  }
  if (overrideCandidates === undefined) {
    if (baseCandidates !== undefined) {
      if (!Array.isArray(baseCandidates)) {
        throw new Error("profile candidates must be an array");
      }
      merged.candidates = [...baseCandidates];
    }
    return merged;
  }
  if (!Array.isArray(overrideCandidates)) {
    throw new Error("profile candidates must be an array");
  }

  const priorCandidates = Array.isArray(baseCandidates) ? baseCandidates : [];
  const mergeMode = candidateMerge || "replace";
  if (mergeMode === "prepend") {
    merged.candidates = [...overrideCandidates, ...priorCandidates];
  } else if (mergeMode === "append") {
    merged.candidates = [...priorCandidates, ...overrideCandidates];
  } else {
    merged.candidates = [...overrideCandidates];
  }
  return merged;
}

function mergeToolConfigs(baseConfig, overrideConfig) {
  if (!overrideConfig) {
    return {
      version: baseConfig.version,
      roles: { ...baseConfig.roles },
      templates: { ...(baseConfig.templates ?? {}) },
      profiles: Object.fromEntries(
        Object.entries(baseConfig.profiles).map(([name, profile]) => [
          name,
          mergeProfile({}, profile),
        ])
      ),
    };
  }

  const merged = {
    version: overrideConfig.version ?? baseConfig.version,
    roles: {
      ...baseConfig.roles,
      ...overrideConfig.roles,
    },
    templates: {
      ...(baseConfig.templates ?? {}),
      ...(overrideConfig.templates ?? {}),
    },
    profiles: Object.fromEntries(
      Object.entries(baseConfig.profiles).map(([name, profile]) => [
        name,
        mergeProfile({}, profile),
      ])
    ),
  };

  for (const [name, profile] of Object.entries(overrideConfig.profiles || {})) {
    merged.profiles[name] = mergeProfile(merged.profiles[name], profile);
  }

  return merged;
}

function loadToolConfig(
  configPath = DEFAULT_CONFIG_PATH,
  localConfigPaths = resolveDefaultLocalConfigPaths()
) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`tool profile config not found: ${configPath}`);
  }
  const baseConfig = applyRoleCompatibility(
    parseToolProfilesToml(fs.readFileSync(configPath, "utf8"))
  );
  let mergedConfig = mergeToolConfigs(baseConfig, null);

  for (const localConfigPath of uniquePaths(
    Array.isArray(localConfigPaths) ? localConfigPaths : [localConfigPaths]
  )) {
    if (!fs.existsSync(localConfigPath)) {
      continue;
    }
    const localConfig = applyRoleCompatibility(
      parseToolProfilesToml(fs.readFileSync(localConfigPath, "utf8"))
    );
    mergedConfig = mergeToolConfigs(mergedConfig, localConfig);
  }

  return mergedConfig;
}

function initializeLocalConfig({ destinationPath, examplePath } = {}) {
  const requestedDestinationPath =
    destinationPath ?? path.join(resolveAgentgearConfigDir(), "tool-profiles.local.toml");
  const requestedExamplePath = examplePath ?? DEFAULT_LOCAL_CONFIG_EXAMPLE_PATH;
  if (
    typeof requestedDestinationPath !== "string" ||
    !requestedDestinationPath.trim()
  ) {
    throw new Error("local config destination path must be non-empty");
  }
  if (typeof requestedExamplePath !== "string" || !requestedExamplePath.trim()) {
    throw new Error("local config example path must be non-empty");
  }

  const resolvedDestinationPath = path.resolve(requestedDestinationPath);
  const resolvedExamplePath = path.resolve(requestedExamplePath);
  if (!fs.existsSync(resolvedExamplePath)) {
    throw new Error(`local config example not found: ${resolvedExamplePath}`);
  }
  const contents = fs.readFileSync(resolvedExamplePath, "utf8");
  fs.mkdirSync(path.dirname(resolvedDestinationPath), { recursive: true });
  try {
    fs.writeFileSync(resolvedDestinationPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(
        `refusing to overwrite existing local config: ${resolvedDestinationPath}`
      );
    }
    throw error;
  }
  return resolvedDestinationPath;
}

function parseThurboxAgentsToml(text) {
  const agentKeys = [];
  const lines = text.split(/\r?\n/);
  let inAgent = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i]).trim().replace(/^\uFEFF/, "");
    if (!line) {
      continue;
    }

    const arraySectionMatch = line.match(/^\[\[(.+)\]\]$/);
    if (arraySectionMatch) {
      inAgent = arraySectionMatch[1].trim() === "agents";
      continue;
    }
    if (/^\[(.+)]$/.test(line)) {
      inAgent = false;
      continue;
    }
    if (!inAgent) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`invalid Thurbox agent assignment on line ${i + 1}`);
    }
    const key = line.slice(0, eqIndex).trim();
    if (key !== "name") {
      continue;
    }
    const agentKey = parseTomlValue(line.slice(eqIndex + 1).trim());
    if (typeof agentKey !== "string" || !agentKey.trim()) {
      throw new Error(
        `Thurbox agent name must be a non-empty string on line ${i + 1}`
      );
    }
    agentKeys.push(agentKey.trim());
  }

  return [...new Set(agentKeys)];
}

function collectConfiguredCandidates(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("tool profile config must be an object");
  }
  if (!config.roles || typeof config.roles !== "object" || Array.isArray(config.roles)) {
    throw new Error("tool profile config roles must be a table");
  }
  if (
    !config.profiles ||
    typeof config.profiles !== "object" ||
    Array.isArray(config.profiles)
  ) {
    throw new Error("tool profile config profiles must be a table");
  }

  for (const [role, profileName] of Object.entries(config.roles)) {
    if (typeof profileName !== "string" || !profileName.trim()) {
      throw new Error(`tool role must name a non-empty profile: ${role}`);
    }
    if (!Object.prototype.hasOwnProperty.call(config.profiles, profileName)) {
      throw new Error(`tool role references an unknown profile: ${role} -> ${profileName}`);
    }
  }

  const configuredCandidates = [];
  for (const profileName of Object.keys(config.profiles).sort()) {
    const profile = config.profiles[profileName];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`tool profile must be a table: ${profileName}`);
    }
    const strategy = profile.strategy ?? "ordered";
    if (strategy !== "ordered") {
      throw new Error(`unsupported tool profile strategy: ${strategy}`);
    }
    if (!Array.isArray(profile.candidates) || !profile.candidates.length) {
      throw new Error(`tool profile must declare at least one candidate: ${profileName}`);
    }

    for (let candidateIndex = 0; candidateIndex < profile.candidates.length; candidateIndex += 1) {
      configuredCandidates.push({
        profile: profileName,
        candidate_index: candidateIndex,
        candidate: normalizeToolCandidate(
          profile.candidates[candidateIndex],
          profileName,
          candidateIndex,
          config.templates
        ),
      });
    }
  }
  return configuredCandidates;
}

function inspectThurboxCli({
  inspectCommand = inspectToolCommand,
  inspectionOptions = {},
} = {}) {
  return inspectCommand("thurbox-cli", {
    cwd: process.cwd(),
    cwdTrusted: true,
    pathEnv: process.env.PATH,
    pathTrusted: true,
    ...inspectionOptions,
  });
}

function checkToolConfig(
  config,
  {
    inspectCommand = inspectToolCommand,
    inspectionOptions = {},
    thurboxInspection,
    thurboxConfigPath = resolveThurboxAgentsConfigPath(),
    readFile = fs.readFileSync,
  } = {}
) {
  const configuredCandidates = collectConfiguredCandidates(config);
  const inspection =
    thurboxInspection ?? inspectThurboxCli({ inspectCommand, inspectionOptions });
  const thurboxAvailable = inspection?.availability === "available";
  const result = {
    valid: true,
    thurbox: {
      available: thurboxAvailable,
    },
    warnings: [],
  };

  if (!thurboxAvailable) {
    if (inspection && inspection.reason) {
      result.thurbox.reason = inspection.reason;
    }
    return result;
  }

  const resolvedThurboxConfigPath = path.resolve(thurboxConfigPath);
  result.thurbox.agents_config_path = resolvedThurboxConfigPath;
  let configuredAgentKeys;
  try {
    configuredAgentKeys = parseThurboxAgentsToml(
      readFile(resolvedThurboxConfigPath, "utf8")
    );
    result.thurbox.agent_keys = configuredAgentKeys;
    if (!configuredAgentKeys.length) {
      result.warnings.push({
        code: "thurbox_agents_config_empty",
        agents_config_path: resolvedThurboxConfigPath,
      });
    }
  } catch (error) {
    configuredAgentKeys = null;
    result.warnings.push({
      code: "thurbox_agents_config_unreadable",
      agents_config_path: resolvedThurboxConfigPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const configuredAgentKeySet = configuredAgentKeys
    ? new Set(configuredAgentKeys)
    : null;
  for (const { profile, candidate_index, candidate } of configuredCandidates) {
    if (!candidate.thurbox_agent_key) {
      result.warnings.push({
        code: "missing_thurbox_agent_key",
        profile,
        candidate_index,
      });
      continue;
    }
    if (
      configuredAgentKeySet &&
      !configuredAgentKeySet.has(candidate.thurbox_agent_key)
    ) {
      result.warnings.push({
        code: "unknown_thurbox_agent_key",
        profile,
        candidate_index,
        thurbox_agent_key: candidate.thurbox_agent_key,
        agents_config_path: resolvedThurboxConfigPath,
      });
    }
  }

  return result;
}

function describeConfigWarning(warning) {
  if (warning.code === "missing_thurbox_agent_key") {
    return `${warning.profile} candidate ${warning.candidate_index + 1}: missing thurbox_agent_key`;
  }
  if (warning.code === "unknown_thurbox_agent_key") {
    return `${warning.profile} candidate ${warning.candidate_index + 1}: thurbox_agent_key ${JSON.stringify(warning.thurbox_agent_key)} is not declared in ${warning.agents_config_path}`;
  }
  if (warning.code === "thurbox_agents_config_empty") {
    return `Thurbox agents configuration has no [[agents]] names: ${warning.agents_config_path}`;
  }
  if (warning.code === "thurbox_agents_config_unreadable") {
    return `cannot read Thurbox agents configuration ${warning.agents_config_path}: ${warning.message}`;
  }
  return JSON.stringify(warning);
}

function applyRoleCompatibility(config) {
  const sourceRoles = config.roles || {};
  const roles = { ...sourceRoles };

  for (const [childRole, parentRole] of Object.entries(
    ROLE_COMPATIBILITY_ALIASES
  )) {
    if (
      Object.prototype.hasOwnProperty.call(sourceRoles, parentRole) &&
      !Object.prototype.hasOwnProperty.call(sourceRoles, childRole)
    ) {
      roles[childRole] = sourceRoles[parentRole];
    }
  }

  return { ...config, roles };
}

function splitCommandLine(commandLine) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let hasWord = false;

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (escaped) {
      current += ch;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = "";
      } else {
        current += ch;
      }
      hasWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = "";
      } else if (ch === "\\") {
        escaped = true;
      } else {
        current += ch;
      }
      hasWord = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      hasWord = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasWord) {
        words.push(current);
        current = "";
        hasWord = false;
      }
      continue;
    }
    current += ch;
    hasWord = true;
  }

  if (quote || escaped) {
    return null;
  }
  if (hasWord) {
    words.push(current);
  }
  return words;
}

function parseEnvironmentAssignment(word) {
  const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  return match ? { name: match[1], value: match[2] } : null;
}

function skipCommandOptions(words, startIndex, environment) {
  let index = startIndex;
  while (index < words.length) {
    const word = words[index];
    if (word === "--") {
      return index + 1;
    }
    const assignment = parseEnvironmentAssignment(word);
    if (assignment) {
      environment[assignment.name] = assignment.value;
      index += 1;
      continue;
    }
    if (word === "-u" || word === "--unset") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function extractCommandExecutable(commandLine) {
  const words = splitCommandLine(commandLine);
  if (!words || !words.length) {
    return { reason: "command_not_parseable" };
  }

  const environment = {};
  let index = 0;
  while (index < words.length) {
    const assignment = parseEnvironmentAssignment(words[index]);
    if (!assignment) {
      break;
    }
    environment[assignment.name] = assignment.value;
    index += 1;
  }
  while (words[index] === "env" || words[index] === "command" || words[index] === "exec") {
    index = skipCommandOptions(words, index + 1, environment);
  }

  const executable = words[index];
  if (!executable) {
    return { reason: "executable_not_detectable" };
  }
  if (/[$`*?\[\]{}]/.test(executable) || executable.startsWith("~")) {
    return { reason: "executable_not_static" };
  }
  return {
    executable,
    path_env: Object.prototype.hasOwnProperty.call(environment, "PATH")
      ? environment.PATH
      : undefined,
  };
}

function inspectToolCommand(
  toolCmd,
  {
    pathEnv = process.env.PATH,
    cwd = process.cwd(),
    pathTrusted = false,
    cwdTrusted = false,
  } = {}
) {
  const extracted = extractCommandExecutable(toolCmd);
  if (!extracted.executable) {
    return {
      availability: "unverified",
      tool_cmd: toolCmd,
      reason: extracted.reason,
    };
  }

  const executable = extracted.executable;
  const executableIsPath = executable.includes("/");
  if (executableIsPath && !path.isAbsolute(executable) && !cwdTrusted) {
    return {
      availability: "unverified",
      tool_cmd: toolCmd,
      executable,
      reason: "target_workdir_unknown",
    };
  }

  const commandPathIsStatic =
    extracted.path_env !== undefined &&
    !/[$`*?\[\]{}~]/.test(extracted.path_env);
  if (extracted.path_env !== undefined && !commandPathIsStatic) {
    return {
      availability: "unverified",
      tool_cmd: toolCmd,
      executable,
      reason: "command_path_not_static",
    };
  }
  const effectivePath = commandPathIsStatic ? extracted.path_env : pathEnv;
  const candidatePaths = executableIsPath
    ? [path.resolve(cwd, executable)]
    : String(effectivePath || "")
        .split(path.delimiter)
        .map((directory) => path.resolve(directory || cwd, executable));
  let foundNonExecutable = false;

  for (const candidatePath of candidatePaths) {
    try {
      if (!fs.statSync(candidatePath).isFile()) {
        foundNonExecutable = true;
        continue;
      }
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return {
        availability: "available",
        tool_cmd: toolCmd,
        executable,
      };
    } catch {
      if (fs.existsSync(candidatePath)) {
        foundNonExecutable = true;
      }
    }
  }

  const contextIsTrusted = executableIsPath
    ? cwdTrusted
    : pathTrusted && extracted.path_env === undefined;
  const reason = foundNonExecutable
    ? "not_executable"
    : executableIsPath
      ? "not_found_at_path"
      : extracted.path_env !== undefined
        ? "not_found_on_command_path"
        : pathTrusted
          ? "not_found_on_target_path"
          : "not_found_on_dispatcher_path";
  return {
    availability: contextIsTrusted ? "unavailable" : "unverified",
    tool_cmd: toolCmd,
    executable,
    reason,
  };
}

function toolCommandDiagnostic(inspection, candidateIndex) {
  const diagnostic = {
    tool_cmd: inspection.tool_cmd,
    reason: inspection.reason,
    candidate_index: candidateIndex,
  };
  if (inspection.executable) {
    diagnostic.executable = inspection.executable;
  }
  return diagnostic;
}

function noUsableToolCommandsError(profileName, unavailableToolCmds) {
  const details = unavailableToolCmds
    .map(({ tool_cmd, executable, reason }) =>
      executable ? `${executable}: ${reason} (${tool_cmd})` : `${reason} (${tool_cmd})`
    )
    .join("; ");
  const error = new Error(`no usable tool commands for profile ${profileName}: ${details}`);
  error.unavailable_tool_cmds = unavailableToolCmds;
  return error;
}

function resolveProfileName(config, role, explicitProfile) {
  if (explicitProfile) {
    return explicitProfile;
  }
  if (role && config.roles[role]) {
    return config.roles[role];
  }
  return "";
}

function expandCommandTemplate(command, templates = {}) {
  return command.replace(/\$\{templates\.([^}]*)\}/g, (placeholder, name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid command template: ${placeholder}`);
    }
    if (!Object.prototype.hasOwnProperty.call(templates, name)) {
      throw new Error(`unknown command template: ${name}`);
    }
    const value = templates[name];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`command template must be a non-empty string: ${name}`);
    }
    return value;
  });
}

function normalizeToolCandidate(candidate, profileName, candidateIndex, templates) {
  if (typeof candidate === "string") {
    if (!candidate.trim()) {
      throw new Error(
        "tool candidate command must be non-empty: " +
          profileName +
          " candidate " +
          candidateIndex
      );
    }
    return { command: expandCommandTemplate(candidate, templates) };
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(
      "tool candidate must be a command string or table: " +
        profileName +
        " candidate " +
        candidateIndex
    );
  }

  if (typeof candidate.command !== "string" || !candidate.command.trim()) {
    throw new Error(
      "tool candidate command must be non-empty: " +
        profileName +
        " candidate " +
        candidateIndex
    );
  }
  if (
    candidate.startup_message !== undefined &&
    (typeof candidate.startup_message !== "string" ||
      !candidate.startup_message.trim())
  ) {
    throw new Error(
      "tool candidate startup_message must be non-empty when set: " +
        profileName +
        " candidate " +
        candidateIndex
    );
  }
  if (
    candidate.thurbox_agent_key !== undefined &&
    (typeof candidate.thurbox_agent_key !== "string" ||
      !candidate.thurbox_agent_key.trim())
  ) {
    throw new Error(
      "tool candidate thurbox_agent_key must be non-empty when set: " +
        profileName +
        " candidate " +
        candidateIndex
    );
  }

  return {
    ...candidate,
    command: expandCommandTemplate(candidate.command, templates),
    ...(candidate.thurbox_agent_key === undefined
      ? {}
      : { thurbox_agent_key: candidate.thurbox_agent_key.trim() }),
  };
}

function resolveProfileCommand(
  config,
  profileName,
  resolutionSource,
  showList = false,
  inspectCommand = inspectToolCommand,
  inspectionOptions = {}
) {
  const profileConfig = config.profiles[profileName];
  if (!profileConfig) {
    throw new Error(`unknown tool profile: ${profileName}`);
  }
  const strategy = profileConfig.strategy ?? "ordered";
  if (strategy !== "ordered") {
    throw new Error(`unsupported tool profile strategy: ${strategy}`);
  }
  const candidates = Array.isArray(profileConfig.candidates)
    ? profileConfig.candidates
    : [];
  const unavailableToolCmds = [];
  const unverifiedToolCmds = [];
  const usableToolCmds = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = normalizeToolCandidate(
      candidates[candidateIndex],
      profileName,
      candidateIndex,
      config.templates
    );
    const toolCmd = candidate.command;
    const inspection = inspectCommand(toolCmd, inspectionOptions);
    if (inspection.availability === "unavailable") {
      unavailableToolCmds.push(toolCommandDiagnostic(inspection, candidateIndex));
      continue;
    }
    if (inspection.availability === "unverified") {
      unverifiedToolCmds.push(toolCommandDiagnostic(inspection, candidateIndex));
    }
    usableToolCmds.push({ candidate, toolCmd, candidateIndex });
  }
  const toolCandidates = usableToolCmds.map(({ candidate }) => ({ ...candidate }));
  if (!toolCandidates.length) {
    if (unavailableToolCmds.length) {
      throw noUsableToolCommandsError(profileName, unavailableToolCmds);
    }
    throw new Error(`no remaining candidates for tool profile: ${profileName}`);
  }
  const selectedIndex = usableToolCmds[0].candidateIndex;
  const selectedCandidate = toolCandidates[0];
  const resolved = {
    tool_profile: profileName,
    resolved_tool_cmd: selectedCandidate.command,
    resolution_source: resolutionSource,
    fallback_index: selectedIndex,
    candidate_count: candidates.length,
  };
  if (!showList && selectedCandidate.startup_message !== undefined) {
    resolved.startup_message = selectedCandidate.startup_message;
  }
  if (selectedCandidate.thurbox_agent_key !== undefined) {
    resolved.thurbox_agent_key = selectedCandidate.thurbox_agent_key;
  }
  if (unavailableToolCmds.length) {
    resolved.unavailable_tool_cmds = unavailableToolCmds;
  }
  if (unverifiedToolCmds.length) {
    resolved.unverified_tool_cmds = unverifiedToolCmds;
  }
  if (showList) {
    resolved.tool_candidates = toolCandidates;
  }
  return resolved;
}

function resolveSingleToolCommand(
  toolCmd,
  toolProfile,
  resolutionSource,
  showList,
  inspectCommand,
  inspectionOptions
) {
  const inspection = inspectCommand(toolCmd, inspectionOptions);
  if (inspection.availability === "unavailable") {
    throw noUsableToolCommandsError(toolProfile, [toolCommandDiagnostic(inspection, 0)]);
  }
  const resolved = {
    tool_profile: toolProfile,
    resolved_tool_cmd: toolCmd,
    resolution_source: resolutionSource,
    fallback_index: 0,
    candidate_count: 1,
  };
  if (inspection.availability === "unverified") {
    resolved.unverified_tool_cmds = [toolCommandDiagnostic(inspection, 0)];
  }
  if (showList) {
    resolved.tool_candidates = [{ command: toolCmd }];
  }
  return resolved;
}

function resolveToolCommand(options = {}) {
  const {
    role = "",
    profile = "",
    command = "",
    inheritCommand = "",
    showList = false,
    inspectCommand = inspectToolCommand,
    inspectionOptions = {},
    config = loadToolConfig(),
  } = options;

  if (command) {
    return resolveSingleToolCommand(
      command,
      profile || "explicit",
      "explicit_command",
      showList,
      inspectCommand,
      inspectionOptions
    );
  }

  const resolvedProfile = resolveProfileName(config, "", profile);
  if (resolvedProfile) {
    return resolveProfileCommand(
      config,
      resolvedProfile,
      "explicit_profile",
      showList,
      inspectCommand,
      inspectionOptions
    );
  }

  if (inheritCommand) {
    return resolveSingleToolCommand(
      inheritCommand,
      "inherited",
      "inherit_command",
      showList,
      inspectCommand,
      inspectionOptions
    );
  }

  const roleDefaultProfile = resolveProfileName(config, role, "");
  if (roleDefaultProfile) {
    return resolveProfileCommand(
      config,
      roleDefaultProfile,
      "role_default_profile",
      showList,
      inspectCommand,
      inspectionOptions
    );
  }

  throw new Error("tool resolution requires an explicit command, profile, inherited command, or role default");
}

function listConfiguredRoles(config) {
  return Object.keys(config.roles).sort();
}

function parseArgs(argv) {
  const options = {
    role: "",
    profile: "",
    command: "",
    inheritCommand: "",
    showList: false,
    listRoles: false,
    workdir: "",
    targetPath: "",
    configPath: DEFAULT_CONFIG_PATH,
    localConfigPaths: resolveDefaultLocalConfigPaths(),
    localConfigExplicit: false,
    initLocalConfig: false,
    checkConfig: false,
    format: "json",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--role") {
      options.role = argv[++i] || "";
    } else if (arg === "--profile") {
      options.profile = argv[++i] || "";
    } else if (arg === "--command") {
      options.command = argv[++i] || "";
    } else if (arg === "--inherit-command") {
      options.inheritCommand = argv[++i] || "";
    } else if (arg === "--show-list") {
      options.showList = true;
    } else if (arg === "--list-roles") {
      options.listRoles = true;
    } else if (arg === "--workdir") {
      options.workdir = argv[++i] || "";
    } else if (arg === "--target-path") {
      options.targetPath = argv[++i] || "";
    } else if (arg === "--config") {
      options.configPath = argv[++i] || "";
    } else if (arg === "--local-config") {
      options.localConfigPaths = [argv[++i] || ""];
      options.localConfigExplicit = true;
    } else if (arg === "--init-local-config") {
      options.initLocalConfig = true;
    } else if (arg === "--check-config") {
      options.checkConfig = true;
    } else if (arg === "--format") {
      options.format = argv[++i] || "json";
    } else if (arg === "--json") {
      options.format = "json";
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (options.initLocalConfig && options.checkConfig) {
    throw new Error("--init-local-config and --check-config cannot be combined");
  }

  if (options.initLocalConfig) {
    if (options.format !== "json" && options.format !== "text") {
      throw new Error(`unsupported output format: ${options.format}`);
    }
    const destinationPath = initializeLocalConfig();
    if (options.format === "text") {
      process.stdout.write(`created local config: ${destinationPath}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ created: destinationPath }, null, 2)}\n`);
    }
    return;
  }

  if (options.checkConfig && options.localConfigExplicit) {
    for (const localConfigPath of options.localConfigPaths) {
      if (!localConfigPath || !fs.existsSync(localConfigPath)) {
        throw new Error(
          `local tool profile config not found: ${path.resolve(localConfigPath || "")}`
        );
      }
    }
  }

  const config = loadToolConfig(options.configPath, options.localConfigPaths);
  if (options.checkConfig) {
    if (options.format !== "json" && options.format !== "text") {
      throw new Error(`unsupported output format: ${options.format}`);
    }
    const checked = checkToolConfig(config);
    if (options.format === "text") {
      const thurboxStatus = checked.thurbox.available
        ? `available (${checked.thurbox.agents_config_path})`
        : "not available";
      process.stdout.write(
        [
          "resolver configuration is valid",
          `thurbox-cli: ${thurboxStatus}`,
          `warnings: ${checked.warnings.length}`,
        ].join("\n") + "\n"
      );
    } else {
      process.stdout.write(`${JSON.stringify(checked, null, 2)}\n`);
    }
    for (const warning of checked.warnings) {
      process.stderr.write(`warning: ${describeConfigWarning(warning)}\n`);
    }
    return;
  }
  if (options.listRoles) {
    const roles = listConfiguredRoles(config);
    if (options.format === "text") {
      process.stdout.write(roles.length ? `${roles.join("\n")}\n` : "");
      return;
    }
    if (options.format !== "json") {
      throw new Error(`unsupported output format: ${options.format}`);
    }
    process.stdout.write(`${JSON.stringify({ roles }, null, 2)}\n`);
    return;
  }

  const inspectionOptions = {
    cwd: options.workdir || process.cwd(),
    cwdTrusted: Boolean(options.workdir),
  };
  if (options.targetPath) {
    inspectionOptions.pathEnv = options.targetPath;
    inspectionOptions.pathTrusted = true;
  }
  const resolved = resolveToolCommand({
    role: options.role,
    profile: options.profile,
    command: options.command,
    inheritCommand: options.inheritCommand,
    showList: options.showList,
    inspectionOptions,
    config,
  });

  if (options.format === "text") {
    const output = options.showList
      ? resolved.tool_candidates.map(({ command }) => command).join("\n")
      : resolved.resolved_tool_cmd;
    process.stdout.write(`${output}\n`);
    return;
  }
  if (options.format !== "json") {
    throw new Error(`unsupported output format: ${options.format}`);
  }
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export {
  DEFAULT_CONFIG_PATH,
  DEFAULT_LOCAL_CONFIG_PATH,
  DEFAULT_LOCAL_CONFIG_EXAMPLE_PATH,
  DEFAULT_LOCAL_CONFIG_PATHS,
  checkToolConfig,
  collectConfiguredCandidates,
  describeConfigWarning,
  inspectToolCommand,
  inspectThurboxCli,
  expandCommandTemplate,
  initializeLocalConfig,
  listConfiguredRoles,
  applyRoleCompatibility,
  loadToolConfig,
  mergeToolConfigs,
  parseThurboxAgentsToml,
  parseToolProfilesToml,
  parseTomlValue,
  resolveAgentgearConfigDir,
  resolveCwdLocalConfigPath,
  resolveDefaultLocalConfigPaths,
  resolveThurboxConfigDir,
  resolveThurboxAgentsConfigPath,
  resolveToolCommand,
  resolveProfileCommand,
  runCli,
};
