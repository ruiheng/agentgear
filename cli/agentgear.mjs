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
import { installSelection, resolveTargetRoots, selected } from "./lib/installer.mjs";
import { parseOptions } from "./lib/options.mjs";
import { runCli as runResolveToolCommand } from "../skills/multi-agent-protocol/scripts/resolve-tool-command.js";

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const rootDir = path.resolve(path.dirname(thisFile), "..");

function print(message = "") {
  process.stdout.write(String(message) + "\n");
}

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    "Usage: agentgear <command> [options]",
    "",
    "Commands:",
    "  list [--json]",
    "  build",
    "  install [--pack NAME] [--skill NAME] [--target NAME[,NAME]] [--scope global|project]",
    "          [--project DIR] [--dest DIR] [--force] [--no-launcher]",
    "  update [install options]",
    "  status [--target NAME[,NAME]] [--scope global|project] [--project DIR] [--dest DIR]",
    "  uninstall (--pack NAME | --skill NAME | --purge) [--target NAME[,NAME]] [--scope global|project]",
    "            [--project DIR] [--dest DIR] [--force]",
    "  doctor [--pack NAME] [--skill NAME]",
    "  resolve-tool-command [resolver options]",
    "  run <skill> <script> [args...]",
    "",
    "install/update copy a release snapshot into targets. The default pack is core."
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
    for (const skill of selection.skills) {
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

  const state = readInstallState();
  const grammar = validateStateGrammar(state);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths().stateFile}: ${grammar.reason}`);
  }
  if (state === null) {
    print("No agentgear installation state recorded; nothing to purge.");
    return;
  }
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
  } else {
    const tornDown = purgeManagedRuntime({ state, env: process.env, print });
    if (tornDown) {
      removeInstallStateFile({ print });
      print("Purge complete.");
    } else {
      process.exitCode = 1;
    }
  }
}

function commandOnPath(command) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Continue searching.
    }
  }
  return false;
}

function sessionHostReady(catalog, hostName, targets) {
  const host = catalog.skills.sessionHosts?.[hostName];
  if (!host) return false;

  let ready = commandOnPath(host.command);
  print((ready ? "ok      " : "unavailable ") + `session host ${hostName} (${host.command})`);

  if (host.upstream) {
    const source = catalog.skills.upstreams[host.upstream];
    if (source?.skillPath) {
      const skillName = path.basename(source.skillPath);
      for (const target of targets) {
        const skillFile = path.join(target.root, skillName, "SKILL.md");
        const found = fs.existsSync(skillFile);
        print((found ? "ok      " : "unavailable ") + "upstream skill " + host.upstream + " for " + target.name);
        if (!found) ready = false;
      }
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
    const found = commandOnPath(command);
    print((found ? "ok      " : "missing ") + command);
    if (!found) missing += 1;
  }
  for (const upstream of selection.requirements.upstreams) {
    const source = catalog.skills.upstreams[upstream];
    if (!source) continue;
    const skillName = path.basename(source.skillPath);
    for (const target of targets) {
      const skillFile = path.join(target.root, skillName, "SKILL.md");
      const found = fs.existsSync(skillFile);
      print((found ? "ok      " : "missing ") + "upstream skill " + upstream + " for " + target.name);
      if (!found) missing += 1;
    }
    print("upstream " + upstream + ": " + source.repository);
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
  for (const target of Object.values(catalog.targets.targets)) {
    fs.cpSync(skillsRoot, path.join(stagingRoot, target.dist), {
      recursive: true,
      preserveTimestamps: true
    });
  }
  fs.writeFileSync(path.join(stagingRoot, "build.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  if (exists(distRoot)) fs.rmSync(distRoot, { recursive: true, force: true });
  fs.renameSync(stagingRoot, distRoot);
  print("Built dist/ for " + Object.keys(catalog.targets.targets).length + " target(s).");
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
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
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
  if (command === "resolve-tool-command") {
    runResolveToolCommand(argumentsList);
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
