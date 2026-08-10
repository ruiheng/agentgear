import fs from "node:fs";
import path from "node:path";

function unique(values) {
  return [...new Set(values)];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function upstreamSkillName(upstream) {
  return path.posix.basename(upstream.skillPath);
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
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function loadCatalog(rootDir) {
  return {
    skills: readJson(path.join(rootDir, "catalog", "skills.json")),
    targets: readJson(path.join(rootDir, "catalog", "targets.json"))
  };
}

export function resolveSelection(catalog, { packs = [], skills = [] } = {}) {
  const selectedPacks = [];
  const selectedSkills = [];
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
      selectedSkills.push(skill);
    }
  }

  // An omitted selection means the complete distribution. An explicit skill is
  // a focused selection, rather than an implicit request for a default pack.
  const requestedPacks = packs.length === 0 && skills.length === 0 ? ["all"] : packs;
  for (const pack of requestedPacks) addPack(pack);
  for (const skill of skills) {
    if (!catalog.skills.skills[skill]) throw new Error(`Unknown skill: ${skill}`);
    selectedSkills.push(skill);
  }

  return {
    packs: selectedPacks,
    skills: unique(selectedSkills),
    requirements: {
      commands: unique(commands),
      upstreams: unique(upstreams),
      sessionHosts: unique(sessionHosts)
    }
  };
}

export function upstreamSkillPlans(catalog, sessionHosts) {
  const plans = [];
  const names = new Set();
  for (const hostName of sessionHosts) {
    const host = catalog.skills.sessionHosts?.[hostName];
    if (!host?.upstream) continue;
    const source = catalog.skills.upstreams?.[host.upstream];
    if (!source?.skillPath) continue;
    const name = upstreamSkillName(source);
    if (names.has(name)) continue;
    names.add(name);
    plans.push({
      host: hostName,
      command: host.command,
      upstream: host.upstream,
      name,
      source
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
  return Object.entries(catalog.skills.skills).map(([name, skill]) => ({
    name,
    tags: skill.tags ?? []
  }));
}
