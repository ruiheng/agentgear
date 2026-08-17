import fs from "node:fs";
import path from "node:path";

function readJsonObject(filePath, label) {
  if (!fs.existsSync(filePath)) return {};
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing unsafe ${label} path: ${filePath}`);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    throw new Error(`failed to parse ${filePath}: ${error.message}`);
  }
}

function storedPermissions(value, source) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(permission => typeof permission !== "string")) {
    throw new Error(`${source} permissions must be an array of strings`);
  }
  return value;
}

export function renderClaimedJsonPermissions({
  settingsPath,
  claimPath,
  registryPath,
  permissions,
  claimDocument,
  retirePermissions = []
}) {
  const settings = readJsonObject(settingsPath, "settings");
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
    settings.permissions = {};
  }
  const currentClaim = readJsonObject(claimPath, "permission claim");
  storedPermissions(currentClaim.permissions, claimPath);
  const otherClaims = new Set();
  const manifestDirectory = path.dirname(claimPath);
  if (fs.statSync(manifestDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of fs.readdirSync(manifestDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:agentgear-preset-[a-z0-9-]+|\.agentgear-workflow-claims)\.json$/.test(entry.name)) continue;
      const candidate = path.join(manifestDirectory, entry.name);
      if (candidate === claimPath) continue;
      const other = readJsonObject(candidate, "permission claim");
      for (const permission of storedPermissions(other.permissions, candidate)) otherClaims.add(permission);
    }
  }
  const prior = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  const priorSet = new Set(prior);
  const registry = readJsonObject(registryPath, "preset ownership registry");
  const introduced = new Set(storedPermissions(registry.introduced_permissions, registryPath));
  const nextClaims = new Set([...otherClaims, ...permissions]);
  const retiredPermissions = new Set([
    ...[...introduced].filter(permission => !nextClaims.has(permission)),
    ...retirePermissions.filter(permission => !nextClaims.has(permission))
  ]);
  const nextIntroduced = new Set([...introduced].filter(permission => nextClaims.has(permission)));
  for (const permission of permissions) {
    if (!priorSet.has(permission)) nextIntroduced.add(permission);
  }
  settings.permissions.allow = [...new Set([
    ...prior.filter(permission => !retiredPermissions.has(permission)),
    ...permissions
  ])];
  return [
    { path: settingsPath, source: `${JSON.stringify(settings, null, 2)}\n` },
    {
      path: claimPath,
      source: `${JSON.stringify({ ...claimDocument, permissions }, null, 2)}\n`
    },
    {
      path: registryPath,
      source: `${JSON.stringify({ version: 1, introduced_permissions: [...nextIntroduced] }, null, 2)}\n`
    }
  ];
}
