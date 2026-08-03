#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPacks,
  listSkills,
  loadCatalog,
  resolveSelection,
  validateCatalog
} from "./lib/catalog.mjs";
import {
  copyOrLinkSkill,
  destinationMatchesRecord,
  directoryFingerprint,
  ensureLauncher,
  ensureWorkflowHelpers,
  exists,
  expandHome,
  purgeManagedRuntime,
  prepareRuntime,
  readInstallState,
  removeInstallStateFile,
  saveInstallState,
  targetState,
  updateTargetState
} from "./lib/runtime.mjs";

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
    "Usage: ai-skills <command> [options]",
    "",
    "Commands:",
    "  list [--json]",
    "  build",
    "  install [--pack NAME] [--skill NAME] [--target NAME[,NAME]] [--scope global|project]",
    "          [--project DIR] [--dest DIR] [--link] [--force] [--dry-run] [--no-launcher]",
    "  update [install options]",
    "  link [install options]",
    "  sync [install options]",
    "  status [--target NAME[,NAME]] [--scope global|project] [--project DIR] [--dest DIR]",
    "  uninstall (--pack NAME | --skill NAME | --purge) [--target NAME[,NAME]] [--scope global|project]",
    "            [--project DIR] [--dest DIR] [--force] [--dry-run]",
    "  doctor [--pack NAME] [--skill NAME]",
    "  run <skill> <script> [args...]",
    "",
    "install/update create a release snapshot. link/sync point targets directly at",
    "the current checkout for rapid development. The default pack is core."
  ].join("\n");
}

function csv(value, option) {
  if (!value) fail("Missing value for " + option);
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function parseOptions(argumentsList) {
  const options = {
    packs: [],
    skills: [],
    targets: [],
    scope: "global",
    project: process.cwd(),
    destination: undefined,
    link: false,
    force: false,
    dryRun: false,
    purge: false,
    noLauncher: false,
    json: false,
    positional: []
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (index >= argumentsList.length) fail("Missing value for " + argument);
      return argumentsList[index];
    };
    switch (argument) {
      case "--pack":
        options.packs.push(...csv(next(), argument));
        break;
      case "--skill":
        options.skills.push(...csv(next(), argument));
        break;
      case "--target":
      case "--provider":
        options.targets.push(...csv(next(), argument));
        break;
      case "--scope":
        options.scope = next();
        break;
      case "--project":
        options.project = next();
        break;
      case "--dest":
        options.destination = next();
        break;
      case "--link":
        options.link = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--purge":
        options.purge = true;
        break;
      case "--no-launcher":
        options.noLauncher = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (argument.startsWith("-")) fail("Unknown option: " + argument);
        options.positional.push(argument);
    }
  }

  if (!["global", "project"].includes(options.scope)) {
    fail("Invalid scope: " + options.scope + ". Use global or project.");
  }
  options.project = path.resolve(options.project);
  return options;
}

function selected(catalog, options) {
  return resolveSelection(catalog, {
    packs: options.packs,
    skills: options.skills
  });
}

function resolveTargetRoots(catalog, options) {
  const names = options.targets.length === 0 ? ["codex"] : options.targets;
  if (options.destination && names.length !== 1) {
    fail("--dest can be used with exactly one --target");
  }
  return names.map(name => {
    const target = catalog.targets.targets[name];
    if (!target) fail("Unknown target: " + name);
    const configuredPath = options.destination || target[options.scope];
    const root = options.scope === "global"
      ? path.resolve(expandHome(configuredPath))
      : path.resolve(options.project, configuredPath);
    return { name, root };
  });
}

function ensureSourceSkills(contentRoot, selection) {
  for (const skill of selection.skills) {
    const skillFile = path.join(contentRoot, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillFile)) fail("Missing canonical skill: " + skillFile);
  }
}

function targetInstallPlan(state, targets, selection, contentRoot, options) {
  const errors = [];
  const plan = [];
  for (const target of targets) {
    const recorded = targetState(state, target.root);
    for (const skill of selection.skills) {
      const source = path.join(contentRoot, "skills", skill);
      const destination = path.join(target.root, skill);
      const record = recorded.skills[skill];
      const destinationExists = exists(destination);
      if (destinationExists && !record && !options.force) {
        errors.push("Unmanaged skill already exists: " + destination);
      } else if (destinationExists && record && !destinationMatchesRecord(destination, record) && !options.force) {
        errors.push("Installer-managed skill changed locally: " + destination + " (use --force to replace it)");
      }
      plan.push({ target, skill, source, destination, record, destinationExists });
    }
  }
  if (errors.length > 0) fail(errors.join("\n"));
  return plan;
}

function removeDestination(destination, dryRun, printLine) {
  if (dryRun) {
    printLine("would replace skill: " + destination);
    return;
  }
  fs.rmSync(destination, { recursive: true, force: true });
}

function install(catalog, options) {
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options);
  const runtime = prepareRuntime({
    sourceRoot: rootDir,
    link: options.link,
    dryRun: options.dryRun,
    print
  });
  const contentRoot = options.dryRun ? rootDir : runtime.root;
  ensureSourceSkills(contentRoot, selection);
  const state = readInstallState();
  const plan = targetInstallPlan(state, targets, selection, contentRoot, options);

  if (!options.noLauncher) {
    ensureLauncher({
      sourceRoot: rootDir,
      runtime,
      force: options.force,
      dryRun: options.dryRun,
      print
    });
    if (selection.skills.includes("agent-deck-workflow")) {
      ensureWorkflowHelpers({
        sourceRoot: rootDir,
        runtime,
        force: options.force,
        dryRun: options.dryRun,
        print
      });
    }
  }

  for (const target of targets) {
    const record = targetState(state, target.root);
    for (const item of plan.filter(candidate => candidate.target.name === target.name)) {
      if (item.destinationExists) removeDestination(item.destination, options.dryRun, print);
      copyOrLinkSkill({
        source: item.source,
        destination: item.destination,
        link: options.link,
        dryRun: options.dryRun,
        print
      });
      if (!options.dryRun) {
        record.skills[item.skill] = {
          source: fs.realpathSync(item.source),
          mode: options.link ? "link" : "copy",
          fingerprint: options.link ? null : directoryFingerprint(item.source),
          runtimeId: runtime.id,
          installedAt: new Date().toISOString()
        };
      }
    }
    if (!options.dryRun) updateTargetState(state, target.root, record);
  }

  if (!options.dryRun) saveInstallState(state);
  const channel = options.link ? "development link" : "release snapshot";
  print("Installed " + selection.skills.length + " skill(s) to " + targets.map(target => target.name).join(", ") + " (" + channel + ").");
  if (selection.requirements.commands.length > 0) {
    print("Run: ai-skills doctor --pack " + selection.packs.at(-1));
  }
}

function status(catalog, options) {
  const state = readInstallState();
  const roots = options.destination || options.targets.length > 0
    ? resolveTargetRoots(catalog, options).map(target => target.root)
    : Object.keys(state.targets).sort();
  if (roots.length === 0) {
    print("No ai-skills installation state recorded.");
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
      const source = skill.mode === "link" ? skill.source : skill.runtimeId;
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

  for (const target of targets) {
    const record = targetState(state, target.root);
    for (const skill of selection.skills) {
      const item = record.skills[skill];
      if (!item) {
        print("Not managed by ai-skills: " + path.join(target.root, skill));
        continue;
      }
      const destination = path.join(target.root, skill);
      if (exists(destination) && !destinationMatchesRecord(destination, item) && !options.force) {
        fail("Refusing to remove locally changed skill: " + destination + " (use --force to remove it)");
      }
      if (options.dryRun) {
        print("would remove skill: " + destination);
      } else {
        fs.rmSync(destination, { recursive: true, force: true });
        delete record.skills[skill];
      }
    }
    if (!options.dryRun) updateTargetState(state, target.root, record);
  }
  if (!options.dryRun) saveInstallState(state);
  print("Uninstall complete.");
}

function developmentSourceRoots(state) {
  const roots = [];
  for (const record of Object.values(state.targets)) {
    for (const [skill, item] of Object.entries(record.skills ?? {})) {
      if (item?.mode !== "link" || typeof item.source !== "string") continue;
      const skillsDirectory = path.dirname(item.source);
      if (path.basename(skillsDirectory) !== "skills" || path.basename(item.source) !== skill) continue;
      roots.push(path.dirname(skillsDirectory));
    }
  }
  return [...new Set(roots)];
}

function purgeTargetRoots(catalog, options, state) {
  const hasExplicitTarget = options.targets.length > 0 || options.destination || options.scope === "project";
  if (hasExplicitTarget) return resolveTargetRoots(catalog, options);
  return Object.keys(state.targets)
    .sort()
    .map(root => ({ name: root, root }));
}

function purgePlan(state, targets, options) {
  const plan = [];
  const errors = [];
  const visitedRoots = new Set();
  for (const target of targets) {
    if (visitedRoots.has(target.root)) continue;
    visitedRoots.add(target.root);
    const record = targetState(state, target.root);
    for (const [skill, item] of Object.entries(record.skills)) {
      const destination = path.join(target.root, skill);
      if (exists(destination) && !destinationMatchesRecord(destination, item) && !options.force) {
        errors.push("Refusing to remove locally changed skill: " + destination + " (use --force to remove it)");
      }
      plan.push({ target, skill, destination });
    }
  }
  if (errors.length > 0) fail(errors.join("\n"));
  return plan;
}

function purge(catalog, options) {
  if (options.packs.length > 0 || options.skills.length > 0) {
    fail("--purge cannot be combined with --pack or --skill");
  }

  const state = readInstallState();
  const knownSourceRoots = developmentSourceRoots(state);
  const targets = purgeTargetRoots(catalog, options, state);
  const plan = purgePlan(state, targets, options);
  const selectedRoots = new Set(targets.map(target => target.root));
  const hasRemainingSkills = Object.keys(state.targets).some(root => !selectedRoots.has(root));

  for (const item of plan) {
    if (options.dryRun) {
      print("would remove skill: " + item.destination);
      continue;
    }
    fs.rmSync(item.destination, { recursive: true, force: true });
    const record = targetState(state, item.target.root);
    delete record.skills[item.skill];
  }

  if (options.dryRun) {
    if (hasRemainingSkills) {
      print("would retain shared runtime because other managed skills remain.");
    } else {
      purgeManagedRuntime({ sourceRoot: rootDir, knownSourceRoots, dryRun: true, print });
      removeInstallStateFile({ dryRun: true, print });
    }
    print("Purge complete (dry run).");
    return;
  }

  for (const target of targets) {
    const record = targetState(state, target.root);
    updateTargetState(state, target.root, record);
  }

  if (Object.keys(state.targets).length > 0) {
    saveInstallState(state);
    print("Shared runtime retained because other managed skills remain.");
  } else {
    purgeManagedRuntime({ sourceRoot: rootDir, knownSourceRoots, dryRun: false, print });
    removeInstallStateFile({ dryRun: false, print });
  }
  print("Purge complete.");
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
  if (missing > 0) {
    process.exitCode = 1;
    print("Missing " + missing + " required command(s).");
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
      install(catalog, options);
      break;
    case "update":
      options.link = false;
      install(catalog, options);
      break;
    case "link":
    case "sync":
      options.link = true;
      install(catalog, options);
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
    process.stderr.write("ai-skills: " + error.message + "\n");
    process.exitCode = 1;
  }
}
