#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execute, isMain, nowIso, resolveCommand } from "./workflow-lib.mjs";
import {
  claudeWaypostPermission,
  isLegacyBroadWaypostPermission,
  readWaypostOwnershipManifest,
  resolveWaypostPermissionContext,
  writeWaypostOwnershipManifest
} from "./waypost-permission-spec.mjs";

const usage = `Initialize Agent Deck permissions for the multi-agent protocol in Claude Code, Codex, and Gemini CLI.

Usage:
  agent-deck-workflow-init-permissions.mjs [project-dir]

The generated rules invoke the stable ~/.local/bin/agentgear launcher, so both
release snapshots and developer links can update skills without rewriting
project permission files.`;

const colors = {
  info: "\x1b[0;34m",
  ok: "\x1b[0;32m",
  warn: "\x1b[1;33m",
  error: "\x1b[0;31m",
  reset: "\x1b[0m"
};

function log(kind, message) {
  process.stdout.write(`${colors[kind]}[${kind.toUpperCase()}]${colors.reset} ${message}\n`);
}

function getHome() {
  return process.env.HOME || os.homedir();
}

function writeAtomic(filePath, content) {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`refusing symlinked or non-file path: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function jsonPermission(command) {
  return `Bash(${command})`;
}

function waypostContext(projectDir) {
  const context = resolveWaypostPermissionContext({ projectDir });
  if (!context.trusted) {
    log("warn", `Skipping Waypost-specific permissions: ${context.reason}`);
  }
  return context;
}

function launcherForms() {
  const absolute = path.join(getHome(), ".local", "bin", "agentgear");
  return ["~/.local/bin/agentgear", absolute];
}

function adwfForms() {
  const absolute = path.join(getHome(), ".local", "bin", "adwf-send-and-wake");
  return ["~/.local/bin/adwf-send-and-wake", absolute];
}

function generatedClaudePermissions(waypostRules) {
  const permissions = [
    jsonPermission("agent-deck"), jsonPermission("agent-deck *"),
    "Bash(git diff)", "Bash(git diff *)", "Bash(git show)", "Bash(git show *)", "Bash(git status)", "Bash(git status *)", "Bash(git log)", "Bash(git log *)", "Bash(git rev-parse)", "Bash(git rev-parse *)",
    ...adwfForms().map(command => jsonPermission(`${command} *`)),
    ...launcherForms().map(command => jsonPermission(`${command} run multi-agent-protocol *`)),
    "Write(/.agent-artifacts/**)"
  ];
  permissions.push(...waypostRules.map(claudeWaypostPermission));
  return [...new Set(permissions)];
}

function isSafeRegularFile(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function configureClaude(projectDir, waypost) {
  log("info", "Configuring Claude Code permissions...");
  const settingsFile = path.join(projectDir, ".claude", "settings.json");
  const settingsInfo = fs.lstatSync(settingsFile, { throwIfNoEntry: false });
  if (settingsInfo && !isSafeRegularFile(settingsFile)) {
    throw new Error(`refusing symlinked or non-file Claude settings path: ${settingsFile}`);
  }
  const alreadyExists = Boolean(settingsInfo);
  const ownership = readWaypostOwnershipManifest(projectDir);
  const ownedWaypostPermissions = new Set(ownership.permissions);
  let settings = {};
  let originalSettings = "";
  if (alreadyExists) {
    log("info", "Merging permissions into existing settings.json");
    const backup = `${settingsFile}.backup.${nowIso().replace(/[-:TZ]/g, "")}`;
    fs.copyFileSync(settingsFile, backup);
    try {
      originalSettings = fs.readFileSync(settingsFile, "utf8");
      settings = JSON.parse(originalSettings);
    } catch (error) {
      throw new Error(`Failed to parse ${settingsFile}: ${error.message}`);
    }
  } else {
    log("info", "Creating new settings.json");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) settings.permissions = {};
  const prior = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  settings.permissions.allow = [...new Set([
    ...prior.filter(item => !ownedWaypostPermissions.has(item) && (ownership.present || !isLegacyBroadWaypostPermission(item))),
    ...generatedClaudePermissions(waypost.rules)
  ])];
  writeAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (waypost.trusted) {
    try {
      writeWaypostOwnershipManifest(projectDir, waypost.rules);
    } catch (error) {
      if (alreadyExists) writeAtomic(settingsFile, originalSettings);
      else fs.rmSync(settingsFile, { force: true });
      throw error;
    }
  }
  log("ok", `${alreadyExists ? "Merged permissions into" : "Created"} ${settingsFile}`);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function codexRule(pattern, justification, extra = "") {
  return `prefix_rule(\n    pattern = [${pattern.map(tomlString).join(", ")}],\n    decision = "allow",\n    justification = ${tomlString(justification)},${extra}\n)\n`;
}

function configureCodex(projectDir, waypost) {
  log("info", "Configuring Codex escalation rules...");
  const rulesFile = path.join(projectDir, ".codex", "rules", "agent-deck-workflow.rules");
  const rules = [
    "# Multi-Agent Protocol - generated approval rules\n",
    codexRule(["agent-deck"], "Agent Deck workflow commands", '\n    match = [\n        "agent-deck",\n        "agent-deck status",\n        "agent-deck session current",\n        "agent-deck workflow dispatch",\n    ]'),
    codexRule(["printf"], "Shell formatting helper commands"),
    ...adwfForms().map(command => codexRule([command], "Workflow send+wakeup helper")),
    ...launcherForms().map(command => codexRule([command, "run", "multi-agent-protocol"], "Protocol scripts through the managed agentgear launcher")),
    ...waypost.rules.filter(item => !item.wildcard).map(item => codexRule([item.command, "--state-dir", item.stateDir, item.action], "Read-only Waypost query")),
    "# Note: file write permissions are controlled separately by the host.\n"
  ].join("\n");
  writeAtomic(rulesFile, rules);
  log("ok", `Created ${rulesFile}`);

  // Updating an existing TOML config without a TOML parser risks clobbering
  // user settings. Surface the rare external-worktree case instead.
  if (process.platform === "linux" && resolveCommand("git")) {
    const result = childProcess.spawnSync("git", ["-C", projectDir, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (result.status === 0) {
      const common = path.resolve(projectDir, result.stdout.trim());
      if (!common.startsWith(`${projectDir}${path.sep}`)) log("info", `External git metadata detected: add ${common} to Codex writable_roots if the host asks for it.`);
    }
  }
}

function geminiRule(name, commandPrefix, toolName = "run_shell_command") {
  return `[[rule]]\nname = ${tomlString(name)}\nenabled = true\ndecision = "allow"\ntoolName = ${tomlString(toolName)}\ncommandPrefix = [${commandPrefix.map(tomlString).join(", ")}]\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`;
}

function configureGemini(projectDir, waypost) {
  log("info", "Configuring Gemini CLI shell policies...");
  const policyFile = path.join(projectDir, ".gemini", "policies", "agent-deck-workflow.toml");
  const policies = [
    "# Multi-Agent Protocol - generated policy rules\n",
    geminiRule("allow_agent_deck_cli", ["agent-deck"]),
    ...(waypost.trusted ? [`[[rule]]\nname = "allow_waypost_mcp"\nenabled = true\ndecision = "allow"\ntoolName = "*"\nmcpName = "waypost"\npriority = 950\nmodes = ["default", "autoEdit", "yolo"]\n`] : []),
    ...adwfForms().map((command, index) => geminiRule(`allow_adwf_send_and_wake_${index}`, [command])),
    ...launcherForms().map((command, index) => geminiRule(`allow_multi_agent_protocol_launcher_${index}`, [command, "run", "multi-agent-protocol"])),
    ...waypost.rules.filter(item => !item.wildcard).map((item, index) => geminiRule(`allow_waypost_cli_${item.action}_${index}`, [item.command, "--state-dir", item.stateDir, item.action])),
    "# Note: file write permissions are controlled separately by the host.\n"
  ].join("\n");
  writeAtomic(policyFile, policies);
  log("ok", `Created ${policyFile}`);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (argv.length > 1) throw new Error("pass at most one project directory");
  const requestedProjectDir = path.resolve(argv[0] || process.cwd());
  if (!fs.statSync(requestedProjectDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`project directory does not exist: ${requestedProjectDir}`);
  const projectDir = fs.realpathSync(requestedProjectDir);
  const waypost = waypostContext(projectDir);
  process.stdout.write("\n========================================\n  Multi-Agent Protocol Permission Setup\n========================================\n\n");
  log("info", `Initializing Agent Deck permissions for: ${projectDir}`);
  if (!resolveCommand("agent-deck")) {
    log("warn", "agent-deck not found in PATH");
    log("info", "Install it from: https://github.com/asheshgoplani/agent-deck");
  }
  configureClaude(projectDir, waypost);
  configureCodex(projectDir, waypost);
  configureGemini(projectDir, waypost);
  process.stdout.write("\n========================================\n  Configuration Complete\n========================================\n\n");
  log("ok", "Permissions configured for multi-agent-protocol");
  log("info", "Next steps: restart your AI agent session, run 'agent-deck workflow init', then use the multi-agent protocol skill.");
}

if (isMain(import.meta.url)) execute(() => main());
