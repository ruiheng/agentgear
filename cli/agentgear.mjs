#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPacks,
  listSkills,
  loadCatalog,
  validateCatalog
} from "./lib/catalog.mjs";
import {
  computePaths,
  destinationMatchesRecord,
  exists,
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
  retrieveUpstreamSkill,
  retrievedUpstreamSkillPlans
} from "./lib/upstreams.mjs";
import {
  SkillContentError,
  buildSkillContentIndex,
  formatSkillText,
  listSkillSelectors,
  resolveSkillOverview,
  resolveSkillSelector
} from "./lib/skill-content.mjs";
import { migrateLegacySkills } from "./lib/legacy-skill-migration.mjs";
import { runSessionCommand } from "./lib/session-hosts.mjs";
import { runCli as runResolveToolCommand } from "../skills/multi-agent-protocol/scripts/resolve-tool-command.js";
import { runPermissionsCommand } from "../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const rootDir = path.resolve(path.dirname(thisFile), "..");

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
    "  skill get [--json] [--] SKILL [SELECTOR...]",
    "  skill list [--json] [--] SKILL",
    "  migrate legacy-skills [--target NAME[,NAME] | --dest DIR] [--scope global|project] [--project DIR] [--apply]",
    "  build",
    "  install [--pack NAME] [--skill NAME] [--target NAME[,NAME]] [--scope global|project]",
    "          [--project DIR] [--dest DIR] [--force] [--no-launcher]",
    "  update [install options]",
    "  status [--target NAME[,NAME]] [--scope global|project] [--project DIR] [--dest DIR]",
    "  uninstall (--pack NAME | --skill NAME | --purge) [--target NAME[,NAME]] [--scope global|project]",
    "            [--project DIR] [--dest DIR] [--force]",
    "  doctor [--pack NAME] [--skill NAME]",
    "  permissions init [--scope user|project] [--project DIR]",
    "  permissions check [--scope user|project] [--project DIR] [--json]",
    "  resolve-tool-command [resolver options]",
    "  session delete --host NAME --session-id ID [--profile NAME] [--json]",
    "  run <skill> <script> [args...]",
    "",
    "Install/update defaults:",
    "  --pack all (when --skill is also omitted)",
    "  --skill alone selects only the named skills",
    `  --target ${DEFAULT_TARGETS.join(",")}`,
    "  --scope global; --project current directory; --dest none",
    "  --force false; --no-launcher false (skip the global command)",
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
      print("  " + name + "  " + skill.mode + "  " + source);
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
      if (!item) {
        print("Not managed by agentgear: " + path.join(target.root, skill));
        continue;
      }
      const destination = path.join(target.root, skill);
      if (exists(destination) && !destinationMatchesRecord(destination, item)) {
        fail("Refusing to remove locally changed skill: " + destination);
      }
      removals.push({ target, record, skill, destination });
    }
  }

  for (const { record, skill, destination } of removals) {
    fs.rmSync(destination, { recursive: true, force: true });
    delete record.skills[skill];
  }
  for (const target of targets) {
    const record = targetState(state, target.root);
    updateTargetState(state, target.root, record);
  }
  saveInstallState(state);
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
      const destination = path.join(target.root, skill);
      if (exists(destination) && !destinationMatchesRecord(destination, item)) {
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
    print("No agentgear installation state recorded; nothing to purge.");
    notifyPermissionMigration(false);
    return;
  }
  if (state === null) {
    for (const item of retrieved.valid) fs.rmSync(item.root, { recursive: true, force: true });
    for (const candidate of retrieved.preserved) print("preserved unverifiable retrieved skill: " + candidate);
    if (retrieved.preserved.length > 0) {
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

  for (const item of plan) {
    fs.rmSync(item.destination, { recursive: true, force: true });
    const record = targetState(state, item.target.root);
    delete record.skills[item.skill];
  }

  for (const target of targets) {
    const record = targetState(state, target.root);
    updateTargetState(state, target.root, record);
  }

  if (Object.keys(state.targets).length > 0) {
    saveInstallState(state);
    print("Shared runtime retained because other managed skills remain.");
    print("Purge complete.");
    notifyPermissionMigration(false);
  } else {
    const tornDown = purgeManagedRuntime({ state, env: process.env, print });
    if (tornDown) {
      removeInstallStateFile({ print });
      for (const item of retrieved.valid) fs.rmSync(item.root, { recursive: true, force: true });
      for (const candidate of retrieved.preserved) print("preserved unverifiable retrieved skill: " + candidate);
      if (retrieved.preserved.length > 0) {
        process.exitCode = 1;
        print("Purge incomplete: retrieved skill materialization requires manual cleanup");
      } else {
        print("Purge complete.");
      }
      notifyPermissionMigration(retiresPermissionCommand);
    } else {
      process.exitCode = 1;
      notifyPermissionMigration(false);
    }
  }

  if (!targetLimited && Object.keys(state.targets).length > 0) {
    // A full purge that keeps managed targets due to changed artifacts must
    // leave globally retrieved documentation alone; it remains usable until
    // a successful full teardown can establish the normal purge ordering.
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
      const retrieved = retrievedUpstreamSkillPlans(catalog);
      const verified = retrieved.valid.some(item => item.plan.upstream === host.upstream);
      const corrupt = retrieved.preserved.find(candidate => candidate.includes(path.sep + path.basename(source.skillPath) + path.sep));
      if (verified) print(`ok      optional documentation ${host.upstream} (verified local resource)`);
      else if (corrupt) print(`warning optional documentation ${host.upstream} (unverifiable local resource: ${corrupt})`);
      else print(`available optional documentation ${host.upstream} (run: agentgear skill get ${path.basename(source.skillPath)})`);
    }
    if (source?.repository) print("upstream " + host.upstream + ": " + source.repository);
  }
  if (host.documentation) print("session host " + hostName + " docs: " + host.documentation);
  return ready;
}

function doctor(catalog, options) {
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options);
  let missing = 0;
  for (const command of selection.requirements.commands) {
    const found = isCommandAvailable(command);
    print((found ? "ok      " : "missing ") + command);
    if (!found) missing += 1;
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

function run(argumentsList) {
  if (argumentsList.length < 2) fail("run requires <skill> <script>");
  const [skill, script, ...scriptArgs] = argumentsList;
  const catalog = loadCatalog(rootDir);
  if (!catalog.skills.skills[skill]) fail("Unknown skill: " + skill);
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
  print("Skills (" + payload.skills.length + "): " + payload.skills.map(skill => skill.name).join(", "));
}

function skillUsage() {
  return [
    "Usage:",
    "  agentgear skill get [--json] [--] SKILL [SELECTOR...]",
    "  agentgear skill list [--json] [--] SKILL"
  ].join("\n");
}

function skill(catalog, argumentsList) {
  const [operation, ...rawArguments] = argumentsList;
  if (!operation || operation === "--help" || operation === "-h") {
    print(skillUsage());
    return;
  }
  const options = parseOptions(rawArguments);
  if (options.help) {
    print(skillUsage());
    return;
  }
  if (options.packs.length || options.skills.length || options.targets.length || options.destination || options.force || options.purge || options.noLauncher || options.apply) {
    fail("skill accepts only --json and positional skill selectors");
  }
  const [skillName, ...selectors] = options.positional;
  if (!skillName) fail(`skill ${operation} requires SKILL`);
  const index = buildSkillContentIndex(rootDir, catalog);
  const upstream = catalog.skills.upstreams?.[skillName];
  if (upstream) {
    if (operation !== "get") fail(`Unknown skill: ${skillName}. Run agentgear list for known skills.`);
    if (selectors.length > 0) throw new SkillContentError(`Unknown selector ${skillName}/${selectors[0]}. Run agentgear skill list ${skillName}.`, { kind: "unknown" });
    const paths = computePaths();
    const resource = retrieveUpstreamSkill({
      catalog,
      skill: skillName,
      runtimeRoots: [paths.currentPath, ...((readInstallState()?.releases ?? []).map(id => path.join(paths.releasesRoot, id)))]
    });
    if (!resource) throw new SkillContentError(`Unknown skill: ${skillName}. Run agentgear list for known skills.`, { kind: "unknown" });
    const overview = fs.readFileSync(path.join(resource.payload, "SKILL.md"), "utf8").replace(/\r\n/g, "\n").replace(/\n*$/, "") + "\n";
    if (options.json) {
      print(JSON.stringify({
        skill: skillName,
        overview,
        resourceBase: resource.payload,
        repository: resource.plan.source.repository,
        ref: resource.plan.source.ref,
        commit: resource.plan.source.commit,
        contentDigest: resource.plan.source.contentDigest
      }, null, 2));
    } else {
      process.stdout.write(`Base directory for this skill: ${resource.payload}\n${overview}`);
    }
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
  const overview = selectors.length === 0 ? resolveSkillOverview(index, skillName) : null;
  const selections = selectors.map(selector => ({ ...resolveSkillSelector(index, skillName, selector), requestedSelector: selector }));
  if (options.json) {
    const payload = overview
      ? { skill: skillName, overview: overview.body }
      : {
        skill: skillName,
        selections: selections.map(record => ({
          requestedSelector: record.requestedSelector,
          owner: record.owner,
          selector: record.canonicalSelector,
          aliases: record.aliases,
          summary: record.summary,
          body: record.body
        }))
      };
    print(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(formatSkillText({ skill: skillName, overview, selections }));
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
  if (options.packs.length || options.skills.length || options.force || options.purge || options.noLauncher || options.json || options.positional.length) {
    fail("legacy-skills accepts only target, destination, scope, project, and --apply options");
  }
  if (options.destination && (options.targets.length > 0 || options.scope !== "global" || options.projectSpecified)) {
    fail("--dest cannot be combined with --target, --scope project, or --project");
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
  if (command === "migrate") {
    migrate(loadCatalog(rootDir), argumentsList);
    return;
  }
  if (command === "resolve-tool-command") {
    runResolveToolCommand(argumentsList);
    return;
  }
  if (command === "permissions") {
    runPermissionsCommand(argumentsList);
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
