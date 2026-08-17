import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { permissionAdapters } from "../../providers/permission-adapters/index.mjs";
import { validatePermissionPreset } from "./permission-preset-schema.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultTargets = ["claude", "codex", "gemini"];

const usage = `Manage reusable development-stack permission presets.

Usage:
  agentgear permissions preset list [--json]
  agentgear permissions preset show NAME [--file FILE]
  agentgear permissions preset add NAME... [--scope user|project] [--project DIR]
                                      [--target claude,codex,gemini,agy]
  agentgear permissions preset add --file FILE [--scope user|project] [--project DIR]
                                      [--target claude,codex,gemini,agy]

Defaults:
  --scope project
  --project current directory
  --target claude,codex,gemini

Agy currently stores permission grants at user scope. Select it explicitly with
--scope user --target agy (or combine it with other user-scoped targets).

Built-in presets are small JSON files. Preset show writes NAME-permissions.json
in the current directory unless --file overrides the path. Customize that file,
then pass it back with preset add --file.`;

function catalog(rootDir = repositoryRoot) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "catalog", "skills.json"), "utf8"));
}

function builtInEntries(rootDir = repositoryRoot) {
  return Object.entries(catalog(rootDir).permissionPresets ?? {}).map(([name, entry]) => ({
    name,
    ...entry,
    file: path.resolve(rootDir, entry.file)
  }));
}

function readPresetFile(filePath) {
  const resolved = path.resolve(filePath);
  const info = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`permission preset is not a safe regular file: ${resolved}`);
  }
  try {
    return validatePermissionPreset(JSON.parse(fs.readFileSync(resolved, "utf8")), resolved);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`failed to parse ${resolved}: ${error.message}`);
    throw error;
  }
}

function loadBuiltIn(name, rootDir = repositoryRoot) {
  const entry = builtInEntries(rootDir).find(item => item.name === name);
  if (!entry) throw new Error(`unknown permission preset: ${name}`);
  const preset = readPresetFile(entry.file);
  if (preset.name !== name) throw new Error(`permission preset name does not match catalog entry: ${name}`);
  return preset;
}

function writeAtomic(filePath, source) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error(`refusing symlinked or non-file path: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, source);
  if (info) fs.chmodSync(temporary, info.mode & 0o777);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function tryWriteNewFile(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, source, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

function writeNewFile(filePath, source) {
  if (!tryWriteNewFile(filePath, source)) {
    throw new Error(`permission preset file already exists: ${filePath}`);
  }
}

function writeDefaultPresetFile(name, source, directory = process.cwd()) {
  for (let suffix = 1; ; suffix += 1) {
    const qualifier = suffix === 1 ? "" : `-${suffix}`;
    const candidate = path.resolve(directory, `${name}-permissions${qualifier}.json`);
    if (tryWriteNewFile(candidate, source)) return candidate;
  }
}

function mutationFiles(plans) {
  return [...new Set(plans.flatMap(plan => Object.values(plan.files)))];
}

function assertProjectMutationPath(projectRoot, filePath) {
  if (!projectRoot) return;
  const relative = path.relative(projectRoot, filePath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`project permission path escapes the project root: ${filePath}`);
  }
  let current = projectRoot;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing symlinked or non-directory project permission path: ${current}`);
    }
  }
}

function capture(plans, projectRoot) {
  return Object.fromEntries(mutationFiles(plans).map(filePath => {
    assertProjectMutationPath(projectRoot, filePath);
    const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`refusing symlinked or non-file path: ${filePath}`);
    return [filePath, info
      ? { existed: true, source: fs.readFileSync(filePath), mode: info.mode & 0o777 }
      : { existed: false }];
  }));
}

function restore(plans, snapshots, projectRoot) {
  for (const filePath of mutationFiles(plans).reverse()) {
    assertProjectMutationPath(projectRoot, filePath);
    const snapshot = snapshots[filePath];
    if (snapshot.existed) {
      writeAtomic(filePath, snapshot.source);
      fs.chmodSync(filePath, snapshot.mode);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
}

export function listPermissionPresets({ rootDir = repositoryRoot } = {}) {
  return builtInEntries(rootDir).map(({ name, file }) => ({
    name,
    description: readPresetFile(file).description
  }));
}

export function addPermissionPresets(presets, {
  scope = "project",
  project = process.cwd(),
  targets = defaultTargets,
  env = process.env
} = {}) {
  if (!Array.isArray(presets) || presets.length === 0) throw new Error("at least one permission preset is required");
  for (const preset of presets) validatePermissionPreset(preset);
  const duplicateNames = presets.map(preset => preset.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`duplicate permission preset(s): ${[...new Set(duplicateNames)].join(",")}`);
  }
  if (!["user", "project"].includes(scope)) throw new Error(`invalid permissions scope: ${scope}`);
  const unknownTargets = targets.filter(target => !permissionAdapters.has(target));
  if (unknownTargets.length > 0 || targets.length === 0 || new Set(targets).size !== targets.length) {
    throw new Error(`invalid permission target(s): ${unknownTargets.join(",") || "none"}; use ${[...permissionAdapters.keys()].join(",")}`);
  }
  const requestedProject = path.resolve(project);
  if (!fs.statSync(requestedProject, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`project directory does not exist: ${requestedProject}`);
  }
  const projectDir = fs.realpathSync(requestedProject);
  const groups = presets.map(preset => ({
    preset,
    plans: targets.map(target => {
      const adapter = permissionAdapters.get(target);
      return {
        preset,
        target,
        adapter,
        ...adapter.resolve({ scope, project: projectDir, presetName: preset.name, env })
      };
    })
  }));
  const plans = groups.flatMap(group => group.plans);
  const mutationRoot = scope === "project" ? projectDir : null;
  const snapshots = capture(plans, mutationRoot);
  try {
    for (const plan of plans) {
      const mutations = plan.adapter.render({ preset: plan.preset, files: plan.files });
      const plannedFiles = new Set(Object.values(plan.files));
      for (const mutation of mutations) {
        if (!plannedFiles.has(mutation.path)) throw new Error(`${plan.target} adapter returned an unplanned mutation path`);
        assertProjectMutationPath(mutationRoot, mutation.path);
        writeAtomic(mutation.path, mutation.source);
      }
    }
  } catch (error) {
    try {
      restore(plans, snapshots, mutationRoot);
    } catch (rollbackError) {
      error.message += `; additionally failed to restore permission files: ${rollbackError.message}`;
    }
    throw error;
  }
  return groups.map(group => ({
    name: group.preset.name,
    scope,
    project: projectDir,
    targets,
    paths: Object.fromEntries(group.plans.map(plan => [plan.target, plan.outputPath]))
  }));
}

export function addPermissionPreset(preset, options = {}) {
  return addPermissionPresets([preset], options)[0];
}

function parse(argv) {
  const [action, ...argumentsList] = argv;
  if (!action || action === "--help" || action === "-h") return { help: true };
  if (!["list", "show", "add"].includes(action)) throw new Error(`unknown permissions preset command: ${action}`);
  const options = { action, names: [], scope: "project", project: process.cwd(), targets: defaultTargets, json: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (index >= argumentsList.length) throw new Error(`missing value for ${argument}`);
      return argumentsList[index];
    };
    if (!argument.startsWith("-")) options.names.push(argument);
    else if (argument === "--scope") options.scope = next();
    else if (argument === "--project") options.project = next();
    else if (argument === "--target") options.targets = next().split(",").filter(Boolean);
    else if (argument === "--file") options.file = next();
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown permissions preset option: ${argument}`);
  }
  return options;
}

export function runPermissionPresetCommand(argv, { rootDir = repositoryRoot, env = process.env } = {}) {
  const options = parse(argv);
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (options.action === "list") {
    if (options.names.length || options.file) throw new Error("preset list does not accept names or files");
    const presets = listPermissionPresets({ rootDir });
    if (options.json) process.stdout.write(`${JSON.stringify(presets, null, 2)}\n`);
    else for (const preset of presets) process.stdout.write(`${preset.name.padEnd(24)} ${preset.description}\n`);
    return;
  }
  if (options.action === "show") {
    if (options.names.length !== 1) throw new Error("preset show requires exactly one built-in preset name");
    const preset = loadBuiltIn(options.names[0], rootDir);
    const source = `${JSON.stringify(preset, null, 2)}\n`;
    let output;
    if (options.file) {
      output = path.resolve(options.file);
      writeNewFile(output, source);
    } else {
      output = writeDefaultPresetFile(preset.name, source);
    }
    process.stdout.write(`Wrote permission preset ${preset.name} to ${output}.\n`);
    return;
  }
  if (options.json) throw new Error("--json is not valid with preset add");
  if (options.file && options.names.length) throw new Error("preset add accepts names or --file, not both");
  if (!options.file && options.names.length === 0) throw new Error("preset add requires at least one name or --file");
  const presets = options.file ? [readPresetFile(options.file)] : options.names.map(name => loadBuiltIn(name, rootDir));
  const results = addPermissionPresets(presets, { ...options, env });
  for (const result of results) {
    process.stdout.write(`Added permission preset ${result.name} to ${result.targets.join(",")} (${result.scope} scope).\n`);
  }
  process.stdout.write("Restart existing agent sessions so they reload the updated permission files.\n");
}

export { validatePermissionPreset as validatePreset };
