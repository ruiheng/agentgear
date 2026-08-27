import fs from "node:fs";
import path from "node:path";
import { validatePermissionPreset } from "./permission-preset-schema.mjs";

function unique(values) {
  return [...new Set(values)];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const MAX_SKILL_NAME_LENGTH = 64;
export const SKILL_PREFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function upstreamSkillName(upstream) {
  return path.posix.basename(upstream.skillPath);
}

function skillCatalog(catalog) {
  return isPlainObject(catalog?.skills?.skills) ? catalog.skills : catalog;
}

export function upstreamSkillEntries(catalog) {
  return Object.entries(skillCatalog(catalog)?.upstreams ?? {}).map(([upstream, source]) => ({
    upstream,
    name: upstreamSkillName(source),
    source: { ...source }
  }));
}

export function upstreamSkillEntry(catalog, name) {
  return upstreamSkillEntries(catalog).find(entry => entry.name === name) ?? null;
}

function isSafeRelativeSkillPath(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const segments = value.split("/");
  return !value.startsWith("/")
    && !value.includes("\\")
    && segments.every(segment => segment && segment !== "." && segment !== "..");
}

function isSafeSkillName(value) {
  return typeof value === "string"
    && value.length <= MAX_SKILL_NAME_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

const RUNTIME_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const RUNTIME_READINESS = new Set(["codegraph-index"]);

export function runtimeCommandValidationErrors(catalog) {
  const errors = [];
  const source = skillCatalog(catalog)?.runtimeCommands;
  if (source === undefined) return errors;
  if (!isPlainObject(source)) return ["runtimeCommands must be an object"];
  for (const [name, definition] of Object.entries(source)) {
    if (!RUNTIME_COMMAND.test(name)) {
      errors.push(`invalid runtime command name: ${JSON.stringify(name)}`);
      continue;
    }
    if (!isPlainObject(definition)) {
      errors.push(`runtime command ${name} must be an object`);
      continue;
    }
    const unknown = Object.keys(definition).filter(key => key !== "readiness");
    if (unknown.length > 0) {
      errors.push(`runtime command ${name} has unsupported field: ${unknown.join(", ")}`);
    }
    if (definition.readiness !== undefined && !RUNTIME_READINESS.has(definition.readiness)) {
      errors.push(`runtime command ${name} has unsupported readiness: ${definition.readiness}`);
    }
    if (definition.readiness === "codegraph-index" && name !== "codegraph") {
      errors.push(`runtime readiness codegraph-index requires command codegraph, not ${name}`);
    }
    if (name === "codegraph" && definition.readiness !== "codegraph-index") {
      errors.push("runtime command codegraph requires readiness codegraph-index");
    }
  }
  return errors;
}

export function runtimeCommands(catalog) {
  const errors = runtimeCommandValidationErrors(catalog);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const source = skillCatalog(catalog)?.runtimeCommands ?? {};
  return new Map(Object.entries(source).map(([name, definition]) => [name, {
    name,
    ...definition
  }]));
}

export function loadCatalog(rootDir) {
  return {
    skills: readJson(path.join(rootDir, "catalog", "skills.json")),
    targets: readJson(path.join(rootDir, "catalog", "targets.json"))
  };
}

export function resolveSelection(catalog, { packs = [], skills = [] } = {}) {
  const selectedPacks = [];
  const capabilitySkills = [];
  const explicitSkills = [];
  const commands = [];
  const upstreams = [];
  const sessionHosts = [];
  const visiting = new Set();

  function addPack(name) {
    if (visiting.has(name)) {
      throw new Error(`Circular pack inclusion: ${[...visiting, name].join(" -> ")}`);
    }
    const pack = catalog.skills.packs[name];
    if (!pack) throw new Error(`Unknown pack: ${name}`);
    if (selectedPacks.includes(name)) return;

    visiting.add(name);
    for (const included of pack.includes ?? []) addPack(included);
    visiting.delete(name);

    selectedPacks.push(name);
    commands.push(...(pack.requires?.commands ?? []));
    upstreams.push(...(pack.requires?.upstreams ?? []));
    sessionHosts.push(...(pack.requires?.sessionHosts ?? []));
    for (const skill of pack.skills ?? []) {
      if (!catalog.skills.skills[skill]) {
        throw new Error(`Pack ${name} references an unknown skill: ${skill}`);
      }
      capabilitySkills.push(skill);
    }
  }

  // An omitted selection means the complete distribution. An explicit skill is
  // a focused selection, rather than an implicit request for a default pack.
  const requestedPacks = packs.length === 0 && skills.length === 0 ? ["all"] : packs;
  for (const pack of requestedPacks) addPack(pack);
  for (const skill of skills) {
    if (!catalog.skills.skills[skill]) throw new Error(`Unknown skill: ${skill}`);
    explicitSkills.push(skill);
  }

  const uniqueCapabilitySkills = unique([...capabilitySkills, ...explicitSkills]);
  const exposedSkills = unique([
    ...capabilitySkills.filter(skill => catalog.skills.skills[skill].exposure === "entry"),
    ...explicitSkills
  ]);

  return {
    packs: selectedPacks,
    // `skills` is retained as a compatibility alias for capability selection.
    skills: uniqueCapabilitySkills,
    explicitSkills: unique(explicitSkills),
    capabilitySkills: uniqueCapabilitySkills,
    exposedSkills,
    requirements: {
      commands: unique(commands),
      upstreams: unique(upstreams),
      sessionHosts: unique(sessionHosts)
    }
  };
}

export function upstreamSkillPlans(catalog, sessionHosts) {
  const definitions = skillCatalog(catalog);
  const plans = [];
  const names = new Set();
  for (const hostName of sessionHosts) {
    const host = definitions.sessionHosts?.[hostName];
    if (!host?.upstream) continue;
    const source = definitions.upstreams?.[host.upstream];
    if (!source?.skillPath) continue;
    const name = upstreamSkillName(source);
    if (names.has(name)) continue;
    names.add(name);
    plans.push({
      host: hostName,
      command: host.command,
      upstream: host.upstream,
      name,
      source: { ...source }
    });
  }
  return plans;
}

export function validateCatalog(rootDir, catalog) {
  const errors = [];
  const sourceRoot = path.join(rootDir, "skills");
  const definedSessionHosts = catalog.skills.sessionHosts ?? {};
  const directoryNames = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const catalogNames = Object.keys(catalog.skills.skills).sort();
  const retiredSkills = catalog.skills.retiredSkills ?? [];
  const presetRoot = path.join(rootDir, "catalog", "permission-presets");
  const declaredPresetFiles = new Set();
  const exposedUpstreams = new Map();

  errors.push(...runtimeCommandValidationErrors(catalog));

  for (const [name, preset] of Object.entries(catalog.skills.permissionPresets ?? {})) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push(`invalid permission preset name: ${name}`);
      continue;
    }
    if (!isPlainObject(preset) || !isSafeRelativeSkillPath(preset.file)) {
      errors.push(`permission preset ${name} must declare a safe file path`);
      continue;
    }
    const presetPath = path.join(rootDir, preset.file);
    declaredPresetFiles.add(path.resolve(presetPath));
    if (!preset.file.startsWith("catalog/permission-presets/") || !fs.statSync(presetPath, { throwIfNoEntry: false })?.isFile()) {
      errors.push(`permission preset ${name} has no catalog file: ${preset.file}`);
      continue;
    }
    try {
      const source = readJson(presetPath);
      validatePermissionPreset(source, `permission preset ${name}`);
      if (source.name !== name) errors.push(`permission preset ${name} file declares a different name`);
    } catch (error) {
      errors.push(`invalid permission preset ${name}: ${error.message}`);
    }
  }
  if (fs.statSync(presetRoot, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of fs.readdirSync(presetRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json") && !declaredPresetFiles.has(path.join(presetRoot, entry.name))) {
        errors.push(`permission preset file is missing from catalog/skills.json: ${entry.name}`);
      }
    }
  }

  if (!Array.isArray(retiredSkills)) {
    errors.push("retiredSkills must be an array");
  } else {
    const seenRetiredSkills = new Set();
    for (const name of retiredSkills) {
      if (!isSafeSkillName(name)) {
        errors.push(`invalid retired skill name: ${JSON.stringify(name)}`);
      } else if (seenRetiredSkills.has(name)) {
        errors.push(`duplicate retired skill name: ${name}`);
      } else if (catalog.skills.skills[name]) {
        errors.push(`retired skill is still active: ${name}`);
      }
      seenRetiredSkills.add(name);
    }
  }

  for (const [name, upstream] of Object.entries(catalog.skills.upstreams ?? {})) {
    if (!isPlainObject(upstream)) {
      errors.push(`upstream ${name} must be an object`);
      continue;
    }
    if (typeof upstream.repository !== "string" || upstream.repository.trim() === "") {
      errors.push(`upstream ${name} is missing repository`);
    }
    if (!isSafeRelativeSkillPath(upstream.skillPath)) {
      errors.push(`upstream ${name} has unsafe skillPath`);
    } else {
      const exposedName = upstreamSkillName(upstream);
      if (!isSafeSkillName(exposedName)) {
        errors.push(`upstream ${name} exposes invalid skill name: ${exposedName}`);
      } else if (catalog.skills.skills[exposedName]) {
        errors.push(`upstream ${name} exposes canonical skill name: ${exposedName}`);
      } else if (exposedUpstreams.has(exposedName)) {
        errors.push(`upstreams ${exposedUpstreams.get(exposedName)} and ${name} expose duplicate skill name: ${exposedName}`);
      } else {
        exposedUpstreams.set(exposedName, name);
      }
    }
    if (typeof upstream.ref !== "string" || upstream.ref.trim() === "") {
      errors.push(`upstream ${name} is missing ref`);
    }
    if (!/^[0-9a-f]{40}$/i.test(upstream.commit ?? "")) {
      errors.push(`upstream ${name} is missing a full commit`);
    }
    if (!/^sha256-v1:[0-9a-f]{64}$/.test(upstream.contentDigest ?? "")) {
      errors.push(`upstream ${name} is missing a canonical content digest`);
    }
  }

  for (const name of directoryNames) {
    if (!catalog.skills.skills[name]) errors.push(`skills/${name} is missing from catalog/skills.json`);
  }
  for (const [name, skill] of Object.entries(catalog.skills.skills)) {
    if (!isPlainObject(skill)) {
      errors.push(`catalog skill ${name} must be an object`);
      continue;
    }
    if (!new Set(["entry", "prompt-only"]).has(skill.exposure)) {
      errors.push(`catalog skill ${name} must declare exposure entry or prompt-only`);
    }
  }
  for (const name of catalogNames) {
    if (!directoryNames.includes(name)) errors.push(`catalog skill ${name} has no skills/${name} directory`);
  }
  for (const [name, pack] of Object.entries(catalog.skills.packs)) {
    for (const included of pack.includes ?? []) {
      if (!catalog.skills.packs[included]) errors.push(`pack ${name} includes unknown pack ${included}`);
    }
    for (const skill of pack.skills ?? []) {
      if (!catalog.skills.skills[skill]) errors.push(`pack ${name} references unknown skill ${skill}`);
    }
    for (const host of pack.requires?.sessionHosts ?? []) {
      if (!definedSessionHosts[host]) errors.push(`pack ${name} references unknown session host ${host}`);
    }
  }
  for (const [name, host] of Object.entries(definedSessionHosts)) {
    if (!host || typeof host !== "object" || Array.isArray(host)) {
      errors.push(`session host ${name} must be an object`);
      continue;
    }
    if (typeof host.command !== "string" || host.command.trim() === "") {
      errors.push(`session host ${name} is missing command`);
    }
    if (host.upstream && !catalog.skills.upstreams[host.upstream]) {
      errors.push(`session host ${name} references unknown upstream ${host.upstream}`);
    }
  }
  return errors;
}

export function listPacks(catalog) {
  return Object.entries(catalog.skills.packs).map(([name, pack]) => ({
    name,
    description: pack.description,
    skills: pack.skills ?? [],
    includes: pack.includes ?? [],
    requirements: pack.requires ?? {}
  }));
}

export function listSkills(catalog) {
  const canonical = Object.entries(catalog.skills.skills).map(([name, skill]) => ({
    name,
    tags: skill.tags ?? [],
    exposure: skill.exposure,
    kind: "canonical",
    installable: true,
    retrievable: true
  }));
  const upstream = upstreamSkillEntries(catalog).map(entry => ({
    name: entry.name,
    tags: [],
    exposure: "upstream",
    kind: "upstream",
    installable: false,
    retrievable: true,
    upstream: entry.upstream,
    description: entry.source.reason ?? "Explicitly retrievable upstream skill."
  }));
  return [...canonical, ...upstream].sort((left, right) => left.name.localeCompare(right.name));
}
