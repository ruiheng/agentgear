import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEGACY_CONFIG = ".gemini/config/skills.json";
const LEGACY_SKILLS = ".gemini/skills";
const OWNERSHIP_KEYS = [
  "schemaVersion", "entryCreated", "fileCreated", "baselineIncludeOnly", "claims"
];
const SKILL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function legacyPaths(env, platform = process.platform) {
  const api = pathApi(platform);
  const home = api.resolve(env.HOME || os.homedir());
  return {
    home,
    platform,
    configPath: api.join(home, LEGACY_CONFIG),
    targetRoot: api.join(home, LEGACY_SKILLS)
  };
}

export function legacyAgyPathIdentity(value, {
  home,
  platform = process.platform
}) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const api = pathApi(platform);
  const expanded = value === "~"
    ? home
    : value.startsWith("~/")
      ? api.join(home, value.slice(2))
      : value;
  const resolved = api.resolve(expanded);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function validateLegacyAgyDiscovery({
  targetPath,
  targetRecord,
  env = process.env,
  platform = process.platform
}) {
  const invalid = reason => ({ valid: false, reason });
  const context = legacyPaths(env, platform);
  const ownership = targetRecord.agyDiscovery;
  if (legacyAgyPathIdentity(targetPath, context)
    !== legacyAgyPathIdentity(context.targetRoot, context)) {
    return invalid(`legacy Agy discovery target must be ${context.targetRoot}`);
  }
  if (!isPlainObject(ownership)
    || Object.keys(ownership).length !== OWNERSHIP_KEYS.length
    || !OWNERSHIP_KEYS.every(key => Object.hasOwn(ownership, key))
    || ownership.schemaVersion !== 1
    || typeof ownership.entryCreated !== "boolean"
    || typeof ownership.fileCreated !== "boolean"
    || !(ownership.baselineIncludeOnly === null
      || (Array.isArray(ownership.baselineIncludeOnly)
        && ownership.baselineIncludeOnly.every(value => typeof value === "string")))
    || !Array.isArray(ownership.claims)
    || ownership.claims.some(claim => !SKILL_KEY_PATTERN.test(claim))
    || ownership.claims.some(claim => !Object.hasOwn(targetRecord.skills, claim))
    || new Set(ownership.claims).size !== ownership.claims.length
    || [...ownership.claims].sort().join("\0") !== ownership.claims.join("\0")) {
    return invalid(`invalid legacy Agy discovery ownership for ${targetPath}`);
  }
  return { valid: true };
}

function preserved(original) {
  return {
    contents: original.contents,
    mode: original.mode,
    value: false
  };
}

function reconcileLegacyConfig(original, ownership, context) {
  if (!original.existed) {
    return { contents: null, mode: original.mode, value: true };
  }

  let config;
  try {
    config = JSON.parse(original.contents.toString("utf8"));
  } catch {
    return preserved(original);
  }
  if (!isPlainObject(config) || (config.entries !== undefined && !Array.isArray(config.entries))) {
    return preserved(original);
  }

  const entries = config.entries ?? [];
  const targetIdentity = legacyAgyPathIdentity(context.targetRoot, context);
  const matches = entries
    .map((entry, index) => isPlainObject(entry)
      && legacyAgyPathIdentity(entry.path, context) === targetIdentity
      ? index
      : -1)
    .filter(index => index >= 0);
  if (matches.length !== 1) return preserved(original);

  const index = matches[0];
  const entry = entries[index];
  const expectedIncludeOnly = sortedUnique([
    ...(ownership.baselineIncludeOnly ?? []),
    ...ownership.claims.map(exactNamePattern)
  ]);
  if (!Array.isArray(entry.include_only)
    || !sameArray(entry.include_only, expectedIncludeOnly)) {
    return preserved(original);
  }

  const nextEntries = [...entries];
  if (ownership.entryCreated) {
    const userFields = Object.keys(entry).filter(key => !["path", "include_only"].includes(key));
    if (userFields.length > 0) return preserved(original);
    nextEntries.splice(index, 1);
  } else if (ownership.baselineIncludeOnly === null) {
    const restored = { ...entry };
    delete restored.include_only;
    nextEntries[index] = restored;
  } else {
    nextEntries[index] = { ...entry, include_only: ownership.baselineIncludeOnly };
  }

  const nextConfig = { ...config, entries: nextEntries };
  const removeFile = ownership.fileCreated
    && nextEntries.length === 0
    && Object.keys(nextConfig).every(key => key === "entries");
  return {
    contents: removeFile ? null : `${JSON.stringify(nextConfig, null, 2)}\n`,
    mode: original.mode,
    value: true
  };
}

function inspectLegacyConfig(context, ownership) {
  try {
    const info = fs.lstatSync(context.configPath, { throwIfNoEntry: false });
    if (!info) return true;
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const original = {
      existed: true,
      contents: fs.readFileSync(context.configPath),
      mode: info.mode & 0o777
    };
    return reconcileLegacyConfig(original, ownership, context).value;
  } catch {
    return false;
  }
}

// Retire metadata written by the short-lived Agy-through-Gemini integration.
// It must never prevent an otherwise valid installation from being updated.
export function retireLegacyAgyDiscovery({
  state,
  transaction,
  env = process.env,
  print = () => {}
}) {
  if (!state) return;
  const context = legacyPaths(env);
  for (const [targetRoot, targetRecord] of Object.entries(state.targets)) {
    if (!Object.hasOwn(targetRecord, "agyDiscovery")) continue;
    const ownership = targetRecord.agyDiscovery;
    let reconciled = false;

    if (legacyAgyPathIdentity(targetRoot, context)
      === legacyAgyPathIdentity(context.targetRoot, context)
      && inspectLegacyConfig(context, ownership)) {
      const attempt = transaction.tryTransformFile(
        context.configPath,
        original => reconcileLegacyConfig(original, ownership, context)
      );
      reconciled = attempt.ok && attempt.value;
    }

    if (reconciled) {
      delete targetRecord.agyDiscovery;
      print(`Migrated legacy Agy discovery state: ${context.configPath}`);
    } else if (Object.keys(targetRecord.skills).length === 0
      || ownership.claims.some(claim => !Object.hasOwn(targetRecord.skills, claim))) {
      delete targetRecord.agyDiscovery;
      print(
        "Preserved legacy Agy discovery config and retired stale ownership "
        + `after managed skills changed: ${context.configPath}`
      );
    } else {
      print(`Preserved legacy Agy discovery config; migration will retry: ${context.configPath}`);
    }
    if (Object.keys(targetRecord.skills).length === 0 && !targetRecord.agyDiscovery) {
      delete state.targets[targetRoot];
    }
  }
}
