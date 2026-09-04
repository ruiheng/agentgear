#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPacks,
  listSkills,
  loadCatalog,
  upstreamSkillEntry,
  validateCatalog
} from "./lib/catalog.mjs";
import {
  computePaths,
  checkStateCoherence,
  createInstallTransaction,
  destinationMatchesRecord,
  exists,
  installedSkillDestination,
  installedSkillName,
  preflightRuntimePurge,
  purgeManagedRuntime,
  readInstallState,
  removeInstallStateFile,
  saveInstallState,
  targetState,
  updateTargetState,
  validateStateGrammar
} from "./lib/runtime.mjs";
import {
  DEFAULT_TARGETS,
  installSelection,
  printPermissionMigrationRequirement,
  resolveTargetRoots,
  retiredPermissionMigrationScopes,
  selected,
  selectedInstallableSkills
} from "./lib/installer.mjs";
import { parseOptions } from "./lib/options.mjs";
import {
  isCommandAvailable,
  purgeRetrievedUpstreamSkills,
  retrieveUpstreamSkill,
  retrievedUpstreamSkillPlans,
  upstreamResourceStatus
} from "./lib/upstreams.mjs";
import {
  SkillContentError,
  appendAgentGuidance,
  appendRuntimeGuidance,
  buildSkillContentIndex,
  formatSkillText,
  listRegisteredActions,
  listSkillSelectors,
  resolveSkillAddress,
  runtimeCommandDefinitions
} from "./lib/skill-content.mjs";
import { resolveAgentProfiles } from "../providers/agent-profiles.mjs";
import { readyExternalCommands } from "../providers/external-commands.mjs";
import { retireLegacyAgyDiscovery } from "../providers/legacy-agy-skill-discovery.mjs";
import { migrateLegacySkills } from "./lib/legacy-skill-migration.mjs";
import { runSessionCommand } from "./lib/session-hosts.mjs";
import { runCli as runResolveToolCommand } from "../skills/multi-agent-protocol/scripts/resolve-tool-command.js";
import { runPermissionsCommand } from "../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";
import { runPermissionPresetCommand } from "./lib/permission-presets.mjs";
import { refreshInstalledCodexHooks } from "./lib/codex-hooks.mjs";
import {
  doctorCodexCompactMemory,
  installCodexCompactMemory,
  uninstallCodexCompactMemory
} from "../providers/codex-compact-memory.mjs";
import { runCompactMemoryHook } from "../skills/multi-agent-protocol/scripts/compact-memory-hook.mjs";

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const rootDir = path.resolve(path.dirname(thisFile), "..");
const minimumWaypostVersion = [0, 8, 0];
const minimumWaypostVersionText = minimumWaypostVersion.join(".");

function print(message = "") {
  process.stdout.write(String(message) + "\n");
}

function fail(message) {
  throw new Error(message);
}

function usage() {
  const catalog = loadCatalog(rootDir);
  return [
    "Usage: agentgear <command> [options]",
    "",
    "Commands:",
    "  list [--json]",
    "  action list [--json]",
    "  skill get [--agent-profile NAME] ADDRESS...",
    "  skill list [--json] [SKILL]",
    "  migrate legacy-skills [--target NAME[,NAME] | --dest DIR] [--scope global|project] [--project DIR] [--apply]",
    "  build",
    "  install [--pack NAME] [--skill NAME] [--target NAME[,NAME]] [--scope global|project]",
    "          [--project DIR] [--dest DIR] [--prefix PREFIX] [--force] [--no-launcher]",
    "  update [install options]",
    "  status [--target NAME[,NAME]] [--scope global|project] [--project DIR] [--dest DIR]",
    "  uninstall (--pack NAME | --skill NAME | --purge) [--target NAME[,NAME]] [--scope global|project]",
    "            [--project DIR] [--dest DIR] [--force]",
    "  doctor [--pack NAME] [--skill NAME]",
    "  permissions init [--scope user|project] [--project DIR]",
    "  permissions check [--scope user|project] [--project DIR] [--json]",
    "  permissions preset list|show|add [options]",
    "  resolve-tool-command [resolver options]",
    "  session delete --host NAME --session-id ID [--profile NAME] [--json]",
    "  hooks install|uninstall|doctor",
    "  run <skill> <script> [args...]",
    "",
    "Install/update defaults:",
    "  --pack all (when --skill is also omitted)",
    "  --skill alone selects only the named skills",
    `  --target ${DEFAULT_TARGETS.join(",")}`,
    "  --scope global; --project current directory; --dest none",
    "  --prefix none; --force false; --no-launcher false (skip the global command)",
    "",
    "With --dest and no --target, Agentgear uses the general target only.",
    "Every installed bootstrap requires agentgear skill get from the matching release.",
    "",
    "Available packs:",
    ...listPacks(catalog).map(pack => `  ${pack.name.padEnd(10)} ${pack.description}`),
    "",
    "Available targets:",
    ...Object.entries(catalog.targets.targets).map(([name, target]) =>
      `  ${name.padEnd(10)} ${target.description}`)
  ].join("\n");
}

function status(catalog, options) {
  const state = readInstallState();
  const grammar = validateStateGrammar(state);
  if (!grammar.valid) {
    print("Invalid installation state: " + computePaths().stateFile);
    print("  " + grammar.reason);
    return;
  }
  if (state === null) {
    print("No agentgear installation state recorded.");
    return;
  }
  const roots = options.destination || options.targets.length > 0
    ? resolveTargetRoots(catalog, options).map(target => target.root)
    : Object.keys(state.targets).sort();
  if (roots.length === 0) {
    print("No agentgear installation state recorded.");
    return;
  }
  for (const root of roots) {
    const record = targetState(state, root);
    const skills = Object.entries(record.skills);
    print(root + ":");
    if (skills.length === 0) {
      print("  no managed skills");
      continue;
    }
    for (const [name, skill] of skills.sort(([left], [right]) => left.localeCompare(right))) {
      const source = skill.mode === "link" ? skill.source : skill.fingerprint;
      const installedAs = installedSkillName(name, state.skillPrefix);
      print("  " + name + (installedAs === name ? "" : ` -> ${installedAs}`) + "  " + skill.mode + "  " + source);
    }
  }
}

function uninstall(catalog, options) {
  if (options.packs.length === 0 && options.skills.length === 0) {
    fail("uninstall requires --pack or --skill");
  }
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options);
  const skills = options.packs.length > 0
    ? [...new Set(selection.capabilitySkills)]
    : selectedInstallableSkills(catalog, selection);
  if (options.packs.length > 0) {
    for (const hostName of selection.requirements.sessionHosts) {
      const upstream = catalog.skills.sessionHosts?.[hostName]?.upstream;
      const source = upstream ? catalog.skills.upstreams?.[upstream] : null;
      if (source?.skillPath) skills.push(path.basename(source.skillPath));
    }
  }
  const state = readInstallState();
  const grammar = validateStateGrammar(state);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths().stateFile}: ${grammar.reason}`);
  }
  if (state === null) {
    fail("No agentgear installation state recorded.");
  }
  // Preflight the complete uninstall scope before any mutation: a mismatch on
  // any selected artifact aborts with every artifact and the state file
  // unchanged, so a late mismatch can never leave earlier deletions recorded.
  const removals = [];
  for (const target of targets) {
    const record = targetState(state, target.root);
    for (const skill of skills) {
      const item = record.skills[skill];
      const installedAs = installedSkillName(skill, state.skillPrefix);
      if (!item) {
        print("Not managed by agentgear: " + path.join(target.root, installedAs));
        continue;
      }
      const destination = path.join(target.root, installedAs);
      if (exists(destination) && !destinationMatchesRecord(destination, item, skill, installedAs)) {
        fail("Refusing to remove locally changed skill: " + destination);
      }
      removals.push({ target, record, skill, destination });
    }
  }
  const transaction = createInstallTransaction();
  try {
    for (const { record, skill, destination } of removals) {
      transaction.remove([destination]);
      delete record.skills[skill];
    }
    for (const target of targets) {
      const record = targetState(state, target.root);
      updateTargetState(state, target.root, record);
    }
    retireLegacyAgyDiscovery({ state, transaction, print });
    saveInstallState(state);
    transaction.commit();
  } catch (error) {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      error.message += `; additionally failed to restore uninstall paths: ${rollbackError.message}`;
    }
    throw error;
  }
  print("Uninstall complete.");
}

function purgeTargetRoots(catalog, options, state) {
  const hasExplicitTarget = options.targets.length > 0 || options.destination || options.scope === "project";
  if (hasExplicitTarget) return resolveTargetRoots(catalog, options);
  return Object.keys(state.targets)
    .sort()
    .map(root => ({ name: root, root }));
}

function purgePlan(state, targets) {
  const plan = [];
  const preserved = [];
  const visitedRoots = new Set();
  for (const target of targets) {
    if (visitedRoots.has(target.root)) continue;
    visitedRoots.add(target.root);
    const record = targetState(state, target.root);
    for (const [skill, item] of Object.entries(record.skills)) {
      const destination = installedSkillDestination(target.root, skill, state.skillPrefix);
      const installedAs = path.basename(destination);
      if (exists(destination) && !destinationMatchesRecord(destination, item, skill, installedAs)) {
        preserved.push(destination);
        continue;
      }
      plan.push({ target, skill, destination });
    }
  }
  return { plan, preserved };
}

function purge(catalog, options) {
  if (options.packs.length > 0 || options.skills.length > 0) {
    fail("--purge cannot be combined with --pack or --skill");
  }
  const detectedPermissionScopes = retiredPermissionMigrationScopes(options);
  const notifyPermissionMigration = commandRetired => printPermissionMigrationRequirement({
    print,
    commandRetired,
    detectedScopes: detectedPermissionScopes
  });
  const state = readInstallState();
  const grammar = validateStateGrammar(state);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths().stateFile}: ${grammar.reason}`);
  }
  const targetLimited = options.targets.length > 0 || options.destination || options.scope === "project";
  const retrieved = targetLimited ? { valid: [], preserved: [] } : retrievedUpstreamSkillPlans(catalog);
  if (state === null && retrieved.valid.length === 0 && retrieved.preserved.length === 0) {
    // Keep the state-null coherence check even on an apparent no-op.
    checkStateCoherence(null);
    print("No agentgear installation state recorded; nothing to purge.");
    notifyPermissionMigration(false);
    return;
  }
  if (state === null) {
    // Preserve the normal managed-runtime coherence gate even when retrieval
    // is the only recorded state. Retrieval cleanup must never legitimize an
    // ambiguous `current` or marked release left beside a missing state file.
    try {
      checkStateCoherence(null);
    } catch (error) {
      fail(error.message);
    }
    const purged = purgeRetrievedUpstreamSkills({ catalog, print });
    if (purged.incomplete) {
      process.exitCode = 1;
      print("Purge incomplete: retrieved skill materialization requires manual cleanup");
    } else {
      print("Purge complete.");
    }
    notifyPermissionMigration(false);
    return;
  }
  const retiredPermissionCommand = computePaths().retiredCommands["adwf-send-and-wake"];
  const retiresPermissionCommand = Boolean(state.commands[retiredPermissionCommand]);
  const targets = purgeTargetRoots(catalog, options, state);
  const { plan, preserved } = purgePlan(state, targets);
  for (const destination of preserved) {
    print("preserved locally changed skill: " + destination);
  }

  // Project the post-purge target state before any mutation. Whenever the
  // purge would leave no target records and therefore attempt runtime
  // teardown, preflight the recorded releases and `current` first regardless
  // of selector syntax; runtime ambiguity preserves everything.
  const willTearDown = preserved.length === 0
    && Object.keys(state.targets).length > 0
    && Object.keys(state.targets).every(root => targets.some(target => target.root === root));
  if (willTearDown) {
    const preflight = preflightRuntimePurge({ state, env: process.env });
    for (const message of preflight.messages) print(message);
    if (!preflight.ok) {
      print("Purge incomplete: runtime ambiguity; manual cleanup required.");
      process.exitCode = 1;
      notifyPermissionMigration(false);
      return;
    }
  }
  const transaction = createInstallTransaction();
  try {
    for (const item of plan) {
      transaction.remove([item.destination]);
      const record = targetState(state, item.target.root);
      delete record.skills[item.skill];
    }
    for (const target of targets) {
      const record = targetState(state, target.root);
      updateTargetState(state, target.root, record);
    }
    retireLegacyAgyDiscovery({ state, transaction, print });

    if (Object.keys(state.targets).length > 0) {
      saveInstallState(state);
      transaction.commit();
      print("Shared runtime retained because other managed skills remain.");
      print("Purge complete.");
      notifyPermissionMigration(false);
    } else {
      const compactMemoryHooks = uninstallCodexCompactMemory({ env: process.env });
      if (compactMemoryHooks.changed) {
        print(`unregistered Agentgear Codex hooks: ${compactMemoryHooks.path}`);
      }
      const tornDown = purgeManagedRuntime({ state, env: process.env, print });
      if (tornDown) {
        removeInstallStateFile({ print });
        transaction.commit();
        const purged = targetLimited ? { incomplete: false } : purgeRetrievedUpstreamSkills({ catalog, print });
        if (purged.incomplete) {
          process.exitCode = 1;
          print("Purge incomplete: retrieved skill materialization requires manual cleanup");
        } else {
          print("Purge complete.");
        }
        notifyPermissionMigration(retiresPermissionCommand);
      } else {
        transaction.rollback();
        process.exitCode = 1;
        notifyPermissionMigration(false);
      }
    }
  } catch (error) {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      error.message += `; additionally failed to restore purge paths: ${rollbackError.message}`;
    }
    throw error;
  }

  if (!targetLimited && Object.keys(state.targets).length > 0) {
    // Full purge handles the independently-owned documentation after state is
    // saved even if locally changed targets remain recorded. It must not let
    // documentation ambiguity block normal target/runtime cleanup.
    const purged = purgeRetrievedUpstreamSkills({ catalog, print });
    if (purged.incomplete) {
      process.exitCode = 1;
      print("Purge incomplete: retrieved skill materialization requires manual cleanup");
    }
  }
}

function sessionHostReady(catalog, hostName, targets) {
  const host = catalog.skills.sessionHosts?.[hostName];
  if (!host) return false;

  let ready = isCommandAvailable(host.command);
  print((ready ? "ok      " : "unavailable ") + `session host ${hostName} (${host.command})`);

  if (host.upstream) {
    const source = catalog.skills.upstreams[host.upstream];
    if (source?.skillPath) {
      const paths = computePaths();
      const runtimes = [paths.currentPath, ...((readInstallState()?.releases ?? [])
        .map(id => path.join(paths.releasesRoot, id)))];
      const resource = upstreamResourceStatus({
        catalog,
        skill: path.basename(source.skillPath),
        runtimeRoots: runtimes
      });
      if (resource?.state === "retrieved" || resource?.state === "runtime") {
        print(`ok      optional documentation ${host.upstream} (verified local resource)`);
      } else if (resource?.state === "corrupt") {
        print(`warning optional documentation ${host.upstream} (unverifiable local resource: ${resource.path})`);
      } else {
        print(`available optional documentation ${host.upstream} (run: agentgear skill get ${path.basename(source.skillPath)})`);
      }
    }
    if (source?.repository) print("upstream " + host.upstream + ": " + source.repository);
  }
  if (host.documentation) print("session host " + hostName + " docs: " + host.documentation);
  return ready;
}

function checkWaypostVersion() {
  const result = childProcess.spawnSync("waypost", ["--version"], {
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  });
  if (result.status !== 0) return { ready: false, detail: "--version failed" };
  const output = String(result.stdout || "").trim();
  const match = /^(?:waypost(?: version)?\s+)?v?(\d+)\.(\d+)\.(\d+)$/.exec(output);
  if (!match) return { ready: false, detail: "invalid --version output" };
  const version = match.slice(1).map(Number);
  let comparison = 0;
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] === minimumWaypostVersion[index]) continue;
    comparison = version[index] > minimumWaypostVersion[index] ? 1 : -1;
    break;
  }
  const ready = comparison >= 0;
  return { ready, version: version.join(".") };
}

function doctor(catalog, options) {
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options);
  let missing = 0;
  for (const command of selection.requirements.commands) {
    let ready = isCommandAvailable(command);
    if (!ready) {
      print("missing " + command);
      missing += 1;
      continue;
    }
    if (command === "waypost") {
      const checked = checkWaypostVersion();
      ready = checked.ready;
      if (ready) {
        print(`ok      waypost ${checked.version} (required >= ${minimumWaypostVersionText})`);
      } else {
        const observed = checked.version ? `; found ${checked.version}` : "";
        print(`incompatible waypost (required >= ${minimumWaypostVersionText}${observed}; ${checked.detail ?? "version too old"})`);
      }
    } else {
      print("ok      " + command);
    }
    if (!ready) missing += 1;
  }
  if (selection.requirements.sessionHosts.length > 0) {
    const readyHosts = selection.requirements.sessionHosts.filter(host => sessionHostReady(catalog, host, targets));
    if (readyHosts.length === 0) {
      missing += 1;
      print("Missing one supported session host: " + selection.requirements.sessionHosts.join(" or ") + ".");
    } else {
      print("Supported session host: " + readyHosts.join(", ") + ".");
    }
  }
  if (missing > 0) {
    process.exitCode = 1;
    print("Missing or incomplete requirement group(s): " + missing + ".");
  } else {
    print("Requirements satisfied for: " + selection.packs.join(", "));
  }
}

function build(catalog) {
  const catalogErrors = validateCatalog(rootDir, catalog);
  if (catalogErrors.length > 0) fail(catalogErrors.join("\n"));

  const distRoot = path.join(rootDir, "dist");
  const stagingRoot = path.join(rootDir, ".dist-" + process.pid + "-" + Date.now());
  const skillsRoot = path.join(rootDir, "skills");
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.cpSync(skillsRoot, path.join(stagingRoot, "universal", "skills"), {
    recursive: true,
    preserveTimestamps: true
  });
  fs.writeFileSync(path.join(stagingRoot, "universal", "README.md"), [
    "# Agentgear universal source material",
    "",
    "The skills tree is non-runnable source material. Its compact bootstraps require the matching same-release agentgear launcher and managed runtime.",
    "Install the npm package or use the normal Agentgear installer; do not copy this tree into a harness discovery directory."
  ].join("\n") + "\n");
  const selection = selected(catalog, parseOptions([]));
  for (const target of Object.values(catalog.targets.targets)) {
    const destination = path.join(stagingRoot, target.dist);
    fs.mkdirSync(destination, { recursive: true });
    for (const skill of selectedInstallableSkills(catalog, selection)) {
      fs.cpSync(path.join(skillsRoot, skill), path.join(destination, skill), {
        recursive: true,
        preserveTimestamps: true
      });
    }
  }
  fs.writeFileSync(path.join(stagingRoot, "build.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  if (exists(distRoot)) fs.rmSync(distRoot, { recursive: true, force: true });
  fs.renameSync(stagingRoot, distRoot);
  print("Built dist/ for " + Object.keys(catalog.targets.targets).length + " target(s).");
}

export function childProcessOutcome(result, label) {
  if (result.error) throw result.error;
  if (result.signal) {
    return { exitCode: 1, diagnostic: `agentgear run: ${label} terminated by ${result.signal}` };
  }
  if (result.status === null || result.status === undefined) {
    return { exitCode: 1, diagnostic: `agentgear run: ${label} ended without an exit status` };
  }
  if (result.status !== 0) {
    return { exitCode: result.status, diagnostic: `agentgear run: ${label} exited with code ${result.status}` };
  }
  return { exitCode: 0, diagnostic: "" };
}

export function resolveRunSkill(catalog, requestedSkill, env = process.env) {
  const candidates = new Set();
  if (catalog.skills.skills[requestedSkill]) candidates.add(requestedSkill);
  const state = readInstallState(env);
  const grammar = validateStateGrammar(state, env);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths(env).stateFile}: ${grammar.reason}`);
  }
  for (const targetRecord of Object.values(state?.targets ?? {})) {
    for (const canonicalSkill of Object.keys(targetRecord.skills ?? {})) {
      if (installedSkillName(canonicalSkill, state.skillPrefix) === requestedSkill) candidates.add(canonicalSkill);
    }
  }
  if (candidates.size === 1) {
    const resolved = candidates.values().next().value;
    if (catalog.skills.skills[resolved]) return resolved;
    fail(`Installed skill ${requestedSkill} maps to unavailable canonical skill ${resolved}`);
  }
  if (candidates.size > 1) {
    fail(`Ambiguous installed skill ${requestedSkill}: ${[...candidates].sort().join(", ")}`);
  }
  fail("Unknown skill: " + requestedSkill);
}

function bundledScriptPaths(scriptsRoot, relative = "") {
  const directory = path.join(scriptsRoot, relative);
  const scripts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) scripts.push(...bundledScriptPaths(scriptsRoot, childRelative));
    else if (entry.isFile()) scripts.push(childRelative.split(path.sep).join("/"));
  }
  return scripts;
}

function runUsage(skill) {
  const lines = [
    `Usage: agentgear run ${skill ? `${skill} ` : "<skill> "}<script> [args...]`,
    "",
    "Run a bundled script owned by a skill.",
    "Pass --help after <script> for script-specific help."
  ];
  if (!skill) return lines.join("\n");

  const scriptsRoot = path.join(rootDir, "skills", skill, "scripts");
  const scripts = fs.statSync(scriptsRoot, { throwIfNoEntry: false })?.isDirectory()
    ? bundledScriptPaths(scriptsRoot)
    : [];
  lines.push("", "Bundled scripts:");
  if (scripts.length === 0) lines.push("  (none)");
  else lines.push(...scripts.map(script => `  ${script}`));
  return lines.join("\n");
}

function run(argumentsList) {
  if (argumentsList.length === 1 && ["--help", "-h"].includes(argumentsList[0])) {
    print(runUsage());
    return;
  }
  if (argumentsList.length < 2) fail("run requires <skill> <script>");
  const [requestedSkill, script, ...scriptArgs] = argumentsList;
  const catalog = loadCatalog(rootDir);
  const skill = resolveRunSkill(catalog, requestedSkill);
  if (["--help", "-h"].includes(script)) {
    print(runUsage(skill));
    return;
  }
  if (path.isAbsolute(script) || script.split(/[\\/]/).includes("..")) {
    fail("Script must be relative to the skill's scripts directory");
  }
  const scriptsRoot = path.join(rootDir, "skills", skill, "scripts");
  const scriptPath = path.resolve(scriptsRoot, script);
  if (!scriptPath.startsWith(scriptsRoot + path.sep) || !fs.statSync(scriptPath, { throwIfNoEntry: false })?.isFile()) {
    fail("Unknown bundled script: " + script);
  }
  const command = /\.(?:cjs|mjs|js)$/.test(script) ? process.execPath : scriptPath;
  const commandArgs = command === process.execPath ? [scriptPath, ...scriptArgs] : scriptArgs;
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  const outcome = childProcessOutcome(result, `${skill}/${script}`);
  if (outcome.diagnostic) process.stderr.write(`${outcome.diagnostic}\n`);
  process.exitCode = outcome.exitCode;
}

function list(catalog, options) {
  const payload = {
    packs: listPacks(catalog),
    skills: listSkills(catalog),
    targets: Object.entries(catalog.targets.targets).map(([name, target]) => ({
      name,
      description: target.description
    }))
  };
  if (options.json) {
    print(JSON.stringify(payload, null, 2));
    return;
  }
  print("Packs:");
  for (const pack of payload.packs) {
    print("  " + pack.name + " — " + pack.description);
  }
  print("");
  print("Targets: " + payload.targets.map(target => target.name).join(", "));
  const canonicalSkills = payload.skills.filter(skill => skill.kind === "canonical");
  const upstreamSkills = payload.skills.filter(skill => skill.kind === "upstream");
  print("Skills (" + canonicalSkills.length + "): " + canonicalSkills.map(skill => skill.name).join(", "));
  if (upstreamSkills.length > 0) {
    print("Upstream retrievable skills: " + upstreamSkills.map(skill => skill.name).join(", "));
  }
}

function skillUsage() {
  return [
    "Usage:",
    "  agentgear skill get [--agent-profile NAME] ADDRESS...",
    "  agentgear skill list [--json] [SKILL]",
    "",
    "Addresses: SKILL loads its entry; SKILL/SELECTOR is exact; a bare SELECTOR",
    "searches all skills and must match exactly one slice. Multiple addresses are allowed.",
    "Agent-specific guidance is selected automatically; --agent-profile is a debug override.",
    "",
    "Examples:",
    "  agentgear skill get review-code",
    "  agentgear skill get review-code/review",
    "  agentgear skill get action:review_requested",
    "  agentgear skill get review-code/review review-code/continue-1",
    "  agentgear skill list",
    "  agentgear skill list review-code",
    "",
    "Remember and reuse skill text unless its bootstrap states a refresh boundary."
  ].join("\n");
}

function skill(catalog, argumentsList) {
  const [operation, ...rawArguments] = argumentsList;
  if (!operation || operation === "--help" || operation === "-h") {
    print(skillUsage());
    return;
  }
  const optionBoundary = rawArguments.indexOf("--");
  const optionArguments = optionBoundary === -1
    ? rawArguments
    : rawArguments.slice(0, optionBoundary);
  if (operation === "get" && optionArguments.includes("--list")) {
    fail("skill get has no --list option; use `agentgear skill list` or `agentgear skill list NAME`");
  }
  const options = parseOptions(rawArguments, { allowAgentProfile: true });
  if (options.help) {
    print(skillUsage());
    return;
  }
  if (operation === "get" && options.json) {
    fail("skill get does not support --json; output is always text");
  }
  if (operation !== "get" && options.agentProfile !== undefined) {
    fail("--agent-profile is only valid with skill get");
  }
  const allowedOptions = operation === "list"
    ? new Set(["json"])
    : new Set(["agent-profile"]);
  if ([...options.supplied].some(option => !allowedOptions.has(option))) {
    fail(operation === "list"
      ? "skill list accepts only --json and one positional skill"
      : "skill get accepts only --agent-profile and positional addresses");
  }
  const [skillName, ...selectors] = options.positional;
  if (!skillName && operation === "list") {
    const records = listSkills(catalog);
    if (options.json) {
      print(JSON.stringify(records, null, 2));
    } else if (records.length > 0) {
      process.stdout.write(records.map(record => record.name).join("\n") + "\n");
    }
    return;
  }
  if (!skillName) {
    fail("skill get requires at least one ADDRESS; try `agentgear skill list`");
  }
  const index = buildSkillContentIndex(rootDir, catalog);
  const upstream = upstreamSkillEntry(catalog, skillName);
  if (upstream) {
    if (operation === "list") {
      if (selectors.length) fail("skill list accepts exactly one SKILL");
      if (options.json) print("[]");
      return;
    }
    if (operation !== "get") fail(`Unknown skill: ${skillName}. Run agentgear list for known skills.`);
    if (options.positional.length > 1) throw new SkillContentError(`Upstream skill ${skillName} cannot be combined with other addresses.`, { kind: "unknown" });
    const paths = computePaths();
    const resource = retrieveUpstreamSkill({
      catalog,
      skill: skillName,
      runtimeRoots: [paths.currentPath, ...((readInstallState()?.releases ?? []).map(id => path.join(paths.releasesRoot, id)))]
    });
    if (!resource) throw new SkillContentError(`Unknown skill: ${skillName}. Run agentgear list for known skills.`, { kind: "unknown" });
    const overview = fs.readFileSync(path.join(resource.payload, "SKILL.md"), "utf8").replace(/\r\n/g, "\n").replace(/\n*$/, "") + "\n";
    process.stdout.write(`Base directory for this skill: ${resource.payload}\n${overview}`);
    return;
  }
  if (operation === "list") {
    if (selectors.length) fail("skill list accepts exactly one SKILL");
    const records = listSkillSelectors(index, skillName);
    if (options.json) {
      print(JSON.stringify(records.map(record => ({
        skill: skillName,
        selector: record.selector,
        owner: record.owner,
        canonicalSelector: record.canonicalSelector,
        aliases: record.aliases,
        summary: record.summary
      })), null, 2));
    } else if (records.length > 0) {
      process.stdout.write(records.map(record => record.selector).join("\n") + "\n");
    }
    return;
  }
  if (operation !== "get") fail(`Unknown skill command: ${operation}`);
  const addresses = options.positional;
  const agentProfiles = resolveAgentProfiles({ override: options.agentProfile });
  const resolvedSelections = addresses.map(address => resolveSkillAddress(index, address));
  const readyCommands = readyExternalCommands(runtimeCommandDefinitions(index, resolvedSelections), {
    workdir: process.cwd()
  });
  const selections = resolvedSelections.map(selection => appendRuntimeGuidance(
    index,
    appendAgentGuidance(index, selection, agentProfiles),
    readyCommands
  ));
  process.stdout.write(formatSkillText({ selections }));
}

function actionUsage() {
  return [
    "Usage: agentgear action list [--json]",
    "",
    "Lists every registered action as an address accepted by `agentgear skill get`."
  ].join("\n");
}

function hooks(argumentsList) {
  const [operation, ...rest] = argumentsList;
  if (!operation || operation === "--help" || operation === "-h") {
    print([
      "Usage: agentgear hooks install|uninstall|doctor",
      "",
      "Install or diagnose Agentgear's optional Codex hooks.",
      "After installation, review and trust all Agentgear hooks with /hooks in Codex."
    ].join("\n"));
    return;
  }
  if (rest.length > 0) fail(`hooks ${operation} does not accept arguments`);
  const launcher = computePaths().launcher;
  if (operation === "install") {
    const result = installCodexCompactMemory({ launcher });
    print(`Agentgear Codex hooks ${result.changed ? "installed" : "already installed"}: ${result.path}`);
    print("Codex hook trust: review all Agentgear hooks with /hooks before use");
    return;
  }
  if (operation === "uninstall") {
    const result = uninstallCodexCompactMemory();
    print(`Agentgear Codex hooks ${result.changed ? "uninstalled" : "not installed"}: ${result.path}`);
    return;
  }
  if (operation === "doctor") {
    const result = doctorCodexCompactMemory({ launcher });
    print(`Agentgear Codex capture hook: ${result.missing.includes("PostToolUse") ? "missing" : "configured"}`);
    print(`Agentgear Codex recovery hook: ${result.missing.includes("SessionStart") ? "missing" : "configured"}`);
    print(`Agentgear Codex upstream recovery hook: ${result.missing.includes("Stop") ? "missing" : "configured"}`);
    print(`Agentgear launcher: ${result.launcherUsable ? "available" : "unusable"}`);
    print("Codex hook trust: not checked; verify with /hooks in Codex");
    print(`Hooks file: ${result.path}`);
    if (result.missing.length > 0 || !result.launcherUsable) process.exitCode = 1;
    return;
  }
  fail(`Unknown hooks command: ${operation}`);
}

function action(catalog, argumentsList) {
  const [operation, ...rawArguments] = argumentsList;
  if (!operation || operation === "--help" || operation === "-h") {
    print(actionUsage());
    return;
  }
  if (operation !== "list") fail(`Unknown action command: ${operation}`);
  const options = parseOptions(rawArguments);
  if (options.help) {
    print(actionUsage());
    return;
  }
  if ([...options.supplied].some(option => option !== "json") || options.positional.length > 0) {
    fail("action list accepts only --json");
  }
  const records = listRegisteredActions(buildSkillContentIndex(rootDir, catalog));
  if (options.json) {
    print(JSON.stringify(records, null, 2));
  } else if (records.length > 0) {
    process.stdout.write(records.map(record => record.address).join("\n") + "\n");
  }
}

function migrate(catalog, argumentsList) {
  const [operation, ...rawArguments] = argumentsList;
  if (operation !== "legacy-skills") fail("migrate supports only legacy-skills");
  const options = parseOptions(rawArguments);
  if (options.help) {
    print("Usage: agentgear migrate legacy-skills [--target NAME[,NAME] | --dest DIR] [--scope global|project] [--project DIR] [--apply]");
    return;
  }
  if (options.packs.length || options.skills.length || options.prefix !== undefined || options.force || options.purge || options.noLauncher || options.json || options.positional.length) {
    fail("legacy-skills accepts only target, destination, scope, project, and --apply options");
  }
  if (options.destination && (options.targets.length > 0 || options.scope !== "global" || options.projectSpecified)) {
    fail("--dest cannot be combined with --target, --scope project, or --project");
  }
  if (options.destination && (!path.isAbsolute(options.destination) || path.resolve(options.destination) !== options.destination)) {
    fail("legacy-skills --dest must be an absolute normalized path");
  }
  let roots;
  if (options.targets.length === 0 && !options.destination && options.scope === "global") {
    roots = ["general", "claude", "kiro"].map(name => resolveTargetRoots(catalog, { ...options, targets: [name] })[0].root);
  } else {
    roots = resolveTargetRoots(catalog, options).map(target => target.root);
  }
  migrateLegacySkills({ roots, apply: options.apply, print });
}

export function main(commandArguments = process.argv.slice(2)) {
  const [command, ...argumentsList] = commandArguments;
  if (!command || command === "--help" || command === "-h") {
    print(usage());
    return;
  }
  if (command === "run") {
    run(argumentsList);
    return;
  }
  if (command === "compact-memory-hook") {
    if (argumentsList.length > 0) fail("compact-memory-hook does not accept arguments");
    runCompactMemoryHook();
    return;
  }
  if (command === "hooks") {
    hooks(argumentsList);
    return;
  }
  if (command === "compact-memory") {
    process.stderr.write("agentgear: `compact-memory` is deprecated; use `agentgear hooks`\n");
    hooks(argumentsList);
    return;
  }
  if (command === "skill") {
    const catalog = loadCatalog(rootDir);
    try {
      skill(catalog, argumentsList);
    } catch (error) {
      if (error instanceof SkillContentError && error.kind === "unknown") {
        process.stderr.write(`agentgear: ${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    return;
  }
  if (command === "action") {
    action(loadCatalog(rootDir), argumentsList);
    return;
  }
  if (command === "migrate") {
    migrate(loadCatalog(rootDir), argumentsList);
    return;
  }
  if (command === "resolve-tool-command") {
    runResolveToolCommand(argumentsList);
    return;
  }
  if (command === "permissions") {
    if (argumentsList[0] === "preset") runPermissionPresetCommand(argumentsList.slice(1));
    else runPermissionsCommand(argumentsList);
    return;
  }
  if (command === "session") {
    runSessionCommand(argumentsList, { print });
    return;
  }
  const options = parseOptions(argumentsList);
  if (options.help) {
    print(usage());
    return;
  }
  if (options.purge && command !== "uninstall") {
    fail("--purge is only valid with uninstall");
  }
  if (options.prefix !== undefined && command !== "install" && command !== "update") {
    fail("--prefix is only valid with install and update");
  }
  const catalog = loadCatalog(rootDir);
  switch (command) {
    case "list":
      list(catalog, options);
      break;
    case "build":
      build(catalog);
      break;
    case "install":
    case "update":
      installSelection({ catalog, options, sourceRoot: rootDir, print });
      refreshInstalledCodexHooks({ print });
      break;
    case "status":
      status(catalog, options);
      break;
    case "uninstall":
      if (options.purge) purge(catalog, options);
      else uninstall(catalog, options);
      break;
    case "doctor":
      doctor(catalog, options);
      break;
    default:
      fail("Unknown command: " + command);
  }
}

export { rootDir };

const invokedFile = process.argv[1] && fs.realpathSync(process.argv[1], { throwIfNoEntry: false });
if (invokedFile === thisFile) {
  try {
    main();
  } catch (error) {
    process.stderr.write("agentgear: " + error.message + "\n");
    process.exitCode = 1;
  }
}
