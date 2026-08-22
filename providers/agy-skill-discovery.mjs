import os from "node:os";
import path from "node:path";

const AGY_SKILLS_CONFIG = "~/.gemini/config/skills.json";
const AGY_GLOBAL_SKILLS = "~/.gemini/skills";
const OWNERSHIP_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function exactNamePattern(name) {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function expandHome(value, home, platform = process.platform) {
  const api = pathApi(platform);
  if (value === "~") return home;
  if (value.startsWith("~/")) return api.join(home, value.slice(2));
  return value;
}

export function agySkillsPathIdentity(value, {
  home,
  platform = process.platform
}) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const api = pathApi(platform);
  const resolved = api.resolve(expandHome(value, home, platform));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveAgyDiscoveryContext(catalog, env = process.env) {
  const home = path.resolve(env.HOME || os.homedir());
  const targetRoot = path.resolve(expandHome(
    catalog.targets.targets.gemini.global,
    home
  ));
  return {
    home,
    platform: process.platform,
    configPath: path.resolve(expandHome(AGY_SKILLS_CONFIG, home)),
    targetRoot,
    entryPath: AGY_GLOBAL_SKILLS,
    entryIdentity: agySkillsPathIdentity(targetRoot, { home })
  };
}

export function isAgyGlobalSkillsPath(value, context) {
  return agySkillsPathIdentity(value, {
    home: context.home,
    platform: context.platform
  }) === context.entryIdentity;
}

function parseConfig(contents, configPath) {
  if (contents === null) return { entries: [] };
  let config;
  try {
    config = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid Agy skills config ${configPath}: ${error.message}`);
  }
  if (!isPlainObject(config)) {
    throw new Error(`Invalid Agy skills config ${configPath}: top-level value must be an object`);
  }
  if (config.entries !== undefined && !Array.isArray(config.entries)) {
    throw new Error(`Invalid Agy skills config ${configPath}: entries must be an array`);
  }
  return { ...config, entries: config.entries ?? [] };
}

function matchingEntryIndexes(config, context) {
  return config.entries
    .map((entry, index) => isPlainObject(entry)
      && agySkillsPathIdentity(entry.path, {
        home: context.home,
        platform: context.platform
      }) === context.entryIdentity
      ? index
      : -1)
    .filter(index => index >= 0);
}

function requireSingleMatch(config, context, required) {
  const matches = matchingEntryIndexes(config, context);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Agy skills config ${context.configPath}: `
      + `multiple entries resolve to ${context.targetRoot}`
    );
  }
  if (required && matches.length === 0) {
    throw new Error(
      `Agy skills config changed outside Agentgear: managed entry is missing from ${context.configPath}`
    );
  }
  return matches[0] ?? -1;
}

function baselineIncludeOnly(entry) {
  if (!Object.hasOwn(entry, "include_only")) return null;
  if (!Array.isArray(entry.include_only)
    || entry.include_only.some(value => typeof value !== "string")) {
    throw new Error("Agy skills config include_only must be an array of strings");
  }
  return [...entry.include_only];
}

function effectiveIncludeOnly(ownership) {
  return sortedUnique([
    ...(ownership.baselineIncludeOnly ?? []),
    ...ownership.claims.map(exactNamePattern)
  ]);
}

function assertManagedEntry(entry, ownership, configPath) {
  if (!Array.isArray(entry.include_only)
    || !sameArray(entry.include_only, effectiveIncludeOnly(ownership))) {
    throw new Error(
      `Agy skills config changed outside Agentgear: managed include_only differs in ${configPath}`
    );
  }
}

export function reconcileAgyDiscoveryConfig(original, desired) {
  const { context, previous } = desired;
  const config = parseConfig(original.contents, context.configPath);
  const index = requireSingleMatch(config, context, Boolean(previous));

  let ownership;
  let entry;
  if (previous) {
    entry = config.entries[index];
    assertManagedEntry(entry, previous, context.configPath);
    ownership = { ...previous };
  } else if (index >= 0) {
    entry = config.entries[index];
    ownership = {
      schemaVersion: OWNERSHIP_VERSION,
      entryCreated: false,
      fileCreated: false,
      baselineIncludeOnly: baselineIncludeOnly(entry),
      claims: []
    };
  } else {
    entry = { path: context.entryPath };
    ownership = {
      schemaVersion: OWNERSHIP_VERSION,
      entryCreated: true,
      fileCreated: !original.existed,
      baselineIncludeOnly: null,
      claims: []
    };
  }

  ownership.claims = desired.claims;
  const entries = [...config.entries];
  const filteringStillRequired = desired.managedSkills
    .some(skill => !ownership.claims.includes(skill));
  if (ownership.claims.length > 0 || filteringStillRequired) {
    const nextEntry = { ...entry, include_only: effectiveIncludeOnly(ownership) };
    if (index >= 0) entries[index] = nextEntry;
    else entries.push(nextEntry);
    return {
      contents: `${JSON.stringify({ ...config, entries }, null, 2)}\n`,
      mode: original.mode,
      value: { ownership }
    };
  }

  if (ownership.entryCreated) {
    const extraKeys = Object.keys(entry).filter(key => !["path", "include_only"].includes(key));
    if (extraKeys.length > 0) {
      throw new Error(
        `Agy skills config changed outside Agentgear: created entry has user fields in ${context.configPath}`
      );
    }
    if (index >= 0) entries.splice(index, 1);
  } else if (ownership.baselineIncludeOnly !== null) {
    entries[index] = { ...entry, include_only: ownership.baselineIncludeOnly };
  } else {
    const restored = { ...entry };
    delete restored.include_only;
    entries[index] = restored;
  }

  const nextConfig = { ...config, entries };
  const removeFile = ownership.fileCreated
    && entries.length === 0
    && Object.keys(nextConfig).every(key => key === "entries");
  return {
    contents: removeFile ? null : `${JSON.stringify(nextConfig, null, 2)}\n`,
    mode: original.mode,
    value: { ownership: null }
  };
}

export function syncAgySkillDiscovery({
  catalog,
  targetRecord,
  claims,
  createIfMissing,
  transaction,
  env = process.env,
  print = () => {}
}) {
  const context = resolveAgyDiscoveryContext(catalog, env);
  const previous = targetRecord.agyDiscovery ?? null;
  if (!previous && !createIfMissing) return false;

  const managedSkills = Object.keys(targetRecord.skills).sort();
  const nextClaims = sortedUnique(claims);
  const managed = new Set(managedSkills);
  const orphanedClaim = nextClaims.find(claim => !managed.has(claim));
  if (orphanedClaim) {
    throw new Error(`Cannot claim an unmanaged Gemini skill for Agy discovery: ${orphanedClaim}`);
  }

  const { ownership } = transaction.transformFile(
    context.configPath,
    original => reconcileAgyDiscoveryConfig(original, {
      context,
      previous,
      managedSkills,
      claims: nextClaims
    })
  );
  if (ownership) targetRecord.agyDiscovery = ownership;
  else delete targetRecord.agyDiscovery;
  print(`${ownership ? "Configured" : "Reconciled"} Agy skill discovery: ${context.configPath}`);
  return true;
}
