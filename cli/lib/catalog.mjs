import fs from "node:fs";
import path from "node:path";

function unique(values) {
  return [...new Set(values)];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    for (const skill of pack.skills ?? []) {
      if (!catalog.skills.skills[skill]) {
        throw new Error(`Pack ${name} references an unknown skill: ${skill}`);
      }
      selectedSkills.push(skill);
    }
  }

  for (const pack of packs.length === 0 ? ["core"] : packs) addPack(pack);
  for (const skill of skills) {
    if (!catalog.skills.skills[skill]) throw new Error(`Unknown skill: ${skill}`);
    selectedSkills.push(skill);
  }

  return {
    packs: selectedPacks,
    skills: unique(selectedSkills),
    requirements: {
      commands: unique(commands),
      upstreams: unique(upstreams)
    }
  };
}

export function validateCatalog(rootDir, catalog) {
  const errors = [];
  const sourceRoot = path.join(rootDir, "skills");
  const directoryNames = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const catalogNames = Object.keys(catalog.skills.skills).sort();

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
