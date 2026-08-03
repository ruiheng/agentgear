import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_MARKER = ".ai-skills-runtime.json";
const STATE_VERSION = 1;
const WORKFLOW_HELPERS = {
  "agent-deck-workflow-init-permissions": "agent-deck-workflow-init-permissions.mjs",
  "adwf-send-and-wake": "adwf-send-and-wake.mjs"
};

export function exists(filePath) {
  return fs.existsSync(filePath) || fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

export function getHome(env = process.env) {
  return env.HOME || os.homedir();
}

export function getDataRoot(env = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(getHome(env), ".local", "share"), "ai-skills");
}

export function getStateFile(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(getHome(env), ".local", "state");
  return path.join(stateHome, "ai-skills", "installs.json");
}

export function expandHome(value, env = process.env) {
  if (value === "~") return getHome(env);
  if (value.startsWith("~/")) return path.join(getHome(env), value.slice(2));
  return value;
}

export function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function walkEntries(rootDir, relative = "") {
  const current = path.join(rootDir, relative);
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const result = [];
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    const entryPath = path.join(rootDir, entryRelative);
    if (entry.isDirectory()) {
      result.push({ type: "directory", relative: entryRelative, path: entryPath });
      result.push(...walkEntries(rootDir, entryRelative));
    } else if (entry.isSymbolicLink()) {
      result.push({ type: "link", relative: entryRelative, path: entryPath });
    } else if (entry.isFile()) {
      result.push({ type: "file", relative: entryRelative, path: entryPath });
    }
  }
  return result;
}

export function directoryFingerprint(rootDir) {
  const hash = crypto.createHash("sha256");
  for (const entry of walkEntries(rootDir)) {
    hash.update(`${entry.type}\0${entry.relative}\0`);
    if (entry.type === "file") {
      hash.update(String(fs.statSync(entry.path).mode & 0o777));
      hash.update("\0");
      hash.update(fs.readFileSync(entry.path));
    } else if (entry.type === "link") {
      hash.update(fs.readlinkSync(entry.path));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function ignoredRuntimePath(sourcePath, sourceRoot) {
  const relative = path.relative(sourceRoot, sourcePath).split(path.sep)[0];
  return [".git", "node_modules", "dist"].includes(relative);
}

function copyRuntime(sourceRoot, destination) {
  fs.cpSync(sourceRoot, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: sourcePath => !ignoredRuntimePath(sourcePath, sourceRoot)
  });
}

function isManagedCurrentLink(currentPath, dataRoot) {
  const info = fs.lstatSync(currentPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  try {
    const target = fs.realpathSync(currentPath);
    return target.startsWith(`${path.join(dataRoot, "releases")}${path.sep}`);
  } catch {
    const target = fs.readlinkSync(currentPath);
    const resolved = path.resolve(path.dirname(currentPath), target);
    return resolved.startsWith(`${path.join(dataRoot, "releases")}${path.sep}`);
  }
}

function resolvedLinkTarget(linkPath) {
  try {
    return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  } catch {
    return null;
  }
}

function linkMatchesAnyTarget(linkPath, targets) {
  const info = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  const expected = new Set(targets.map(target => path.resolve(target)));
  const linkedTarget = resolvedLinkTarget(linkPath);
  if (linkedTarget && expected.has(linkedTarget)) return true;
  try {
    return expected.has(fs.realpathSync(linkPath));
  } catch {
    return false;
  }
}

function isManagedRuntimeRelease(releasePath, releaseId) {
  const markerPath = path.join(releasePath, RUNTIME_MARKER);
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return marker.schemaVersion === STATE_VERSION && marker.releaseId === releaseId;
  } catch {
    return false;
  }
}

function managedRuntimeReleases(dataRoot) {
  const releasesRoot = path.join(dataRoot, "releases");
  const rootInfo = fs.lstatSync(releasesRoot, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return [];
  return fs.readdirSync(releasesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => isManagedRuntimeRelease(path.join(releasesRoot, entry.name), entry.name))
    .map(entry => path.join(releasesRoot, entry.name));
}

function removeEmptyDirectory(directory) {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function removeManagedPath(kind, destination, dryRun, print) {
  if (dryRun) {
    print(`would remove ${kind}: ${destination}`);
    return;
  }
  fs.rmSync(destination, { recursive: true, force: true });
  print(`removed ${kind}: ${destination}`);
}

export function prepareRuntime({ sourceRoot, link, dryRun, env = process.env, print }) {
  if (link) {
    return { root: sourceRoot, id: `link:${sourceRoot}`, mode: "link" };
  }

  const dataRoot = getDataRoot(env);
  const releasesRoot = path.join(dataRoot, "releases");
  const packageJson = readJsonIfExists(path.join(sourceRoot, "package.json"), { version: "dev" });
  const releaseId = `${packageJson.version}-${Date.now()}`;
  const releasePath = path.join(releasesRoot, releaseId);
  const currentPath = path.join(dataRoot, "current");

  if (dryRun) {
    print(`would stage runtime: ${releasePath}`);
    print(`would update runtime link: ${currentPath}`);
    return { root: releasePath, id: releaseId, mode: "copy" };
  }

  fs.mkdirSync(releasesRoot, { recursive: true });
  const stagingPath = path.join(releasesRoot, `.${releaseId}.staging`);
  copyRuntime(sourceRoot, stagingPath);
  writeJsonAtomic(path.join(stagingPath, RUNTIME_MARKER), {
    schemaVersion: STATE_VERSION,
    releaseId,
    sourceRoot,
    installedAt: new Date().toISOString()
  });
  fs.renameSync(stagingPath, releasePath);

  if (exists(currentPath)) {
    if (!isManagedCurrentLink(currentPath, dataRoot)) {
      throw new Error(`Refusing to replace unmanaged runtime path: ${currentPath}`);
    }
    fs.unlinkSync(currentPath);
  }
  fs.symlinkSync(releasePath, currentPath, process.platform === "win32" ? "junction" : "dir");
  return { root: releasePath, id: releaseId, mode: "copy" };
}

function launcherIsManaged(launcherPath, sourceRoot, dataRoot) {
  const info = fs.lstatSync(launcherPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  try {
    const target = fs.realpathSync(launcherPath);
    const sourceLauncher = fs.realpathSync(path.join(sourceRoot, "bin", "ai-skills.mjs"));
    const managedLauncher = path.join(dataRoot, "current", "bin", "ai-skills.mjs");
    const managedTarget = fs.existsSync(managedLauncher) ? fs.realpathSync(managedLauncher) : null;
    return target === sourceLauncher || target === managedTarget;
  } catch {
    return false;
  }
}

export function ensureLauncher({ sourceRoot, runtime, force, dryRun, env = process.env, print }) {
  const dataRoot = getDataRoot(env);
  const destination = path.join(getHome(env), ".local", "bin", "ai-skills");
  const target = runtime.mode === "link"
    ? path.join(sourceRoot, "bin", "ai-skills.mjs")
    : path.join(dataRoot, "current", "bin", "ai-skills.mjs");

  if (exists(destination)) {
    if (!force && !launcherIsManaged(destination, sourceRoot, dataRoot)) {
      throw new Error(`Refusing to replace unmanaged launcher: ${destination}`);
    }
    if (dryRun) {
      print(`would replace launcher: ${destination}`);
      return destination;
    }
    fs.rmSync(destination, { force: true });
  }

  if (dryRun) {
    print(`would install launcher: ${destination} -> ${target}`);
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(target, destination);
  return destination;
}

function helperIsManaged(destination, target, dataRoot, sourceRoot) {
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  try {
    if (fs.readlinkSync(destination) === target) return true;
    const resolved = fs.realpathSync(destination);
    const releasesRoot = path.join(dataRoot, "releases") + path.sep;
    const sourceScriptsRoot = path.join(sourceRoot, "skills", "agent-deck-workflow", "scripts") + path.sep;
    return resolved.startsWith(releasesRoot) || resolved.startsWith(sourceScriptsRoot);
  } catch {
    return false;
  }
}

export function ensureWorkflowHelpers({ sourceRoot, runtime, force, dryRun, env = process.env, print }) {
  const dataRoot = getDataRoot(env);
  const localBin = path.join(getHome(env), ".local", "bin");
  const runtimeRoot = runtime.mode === "link" ? sourceRoot : path.join(dataRoot, "current");

  for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
    const destination = path.join(localBin, name);
    const target = path.join(runtimeRoot, "skills", "agent-deck-workflow", "scripts", script);
    if (exists(destination)) {
      if (!force && !helperIsManaged(destination, target, dataRoot, sourceRoot)) {
        throw new Error("Refusing to replace unmanaged workflow helper: " + destination);
      }
      if (dryRun) {
        print("would refresh workflow helper: " + destination);
        continue;
      }
      fs.rmSync(destination, { force: true });
    }
    if (dryRun) {
      print("would install workflow helper: " + destination + " -> " + target);
      continue;
    }
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(target, destination);
  }
}

export function purgeManagedRuntime({
  sourceRoot,
  knownSourceRoots = [],
  dryRun,
  env = process.env,
  print
}) {
  const dataRoot = getDataRoot(env);
  const currentPath = path.join(dataRoot, "current");
  const releasesRoot = path.join(dataRoot, "releases");
  const releaseRoots = managedRuntimeReleases(dataRoot);
  const sourceRoots = [...new Set([sourceRoot, ...knownSourceRoots]
    .filter(candidate => typeof candidate === "string" && candidate.length > 0)
    .map(candidate => path.resolve(candidate)))];
  const currentIsManaged = isManagedCurrentLink(currentPath, dataRoot);
  const localBin = path.join(getHome(env), ".local", "bin");

  const launcherTargets = [
    ...sourceRoots.map(root => path.join(root, "bin", "ai-skills.mjs")),
    ...releaseRoots.map(root => path.join(root, "bin", "ai-skills.mjs"))
  ];
  if (currentIsManaged) launcherTargets.push(path.join(currentPath, "bin", "ai-skills.mjs"));
  const launcher = path.join(localBin, "ai-skills");
  if (linkMatchesAnyTarget(launcher, launcherTargets)) {
    removeManagedPath("launcher", launcher, dryRun, print);
  }

  for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
    const helper = path.join(localBin, name);
    const targets = [
      ...sourceRoots.map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script)),
      ...releaseRoots.map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script))
    ];
    if (currentIsManaged) {
      targets.push(path.join(currentPath, "skills", "agent-deck-workflow", "scripts", script));
    }
    if (linkMatchesAnyTarget(helper, targets)) {
      removeManagedPath("workflow helper", helper, dryRun, print);
    }
  }

  if (currentIsManaged) removeManagedPath("runtime link", currentPath, dryRun, print);
  for (const releaseRoot of releaseRoots) {
    removeManagedPath("runtime release", releaseRoot, dryRun, print);
  }

  if (!dryRun) {
    removeEmptyDirectory(releasesRoot);
    removeEmptyDirectory(dataRoot);
  }
}

export function removeInstallStateFile({ dryRun, env = process.env, print }) {
  const stateFile = getStateFile(env);
  const info = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return;
  removeManagedPath("installation state", stateFile, dryRun, print);
  if (!dryRun) removeEmptyDirectory(path.dirname(stateFile));
}

export function readInstallState(env = process.env) {
  return readJsonIfExists(getStateFile(env), {
    schemaVersion: STATE_VERSION,
    targets: {}
  });
}

export function saveInstallState(state, env = process.env) {
  writeJsonAtomic(getStateFile(env), state);
}

export function targetState(state, targetPath) {
  return state.targets[targetPath] ?? { skills: {} };
}

export function updateTargetState(state, targetPath, value) {
  if (Object.keys(value.skills).length === 0) {
    delete state.targets[targetPath];
  } else {
    state.targets[targetPath] = value;
  }
}

export function copyOrLinkSkill({ source, destination, link, dryRun, print }) {
  if (dryRun) {
    print(`would ${link ? "link" : "copy"} skill: ${source} -> ${destination}`);
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (link) {
    fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
  } else {
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  }
}

export function destinationMatchesRecord(destination, record) {
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info) return false;
  if (record.mode === "link") {
    try {
      return info.isSymbolicLink() && fs.realpathSync(destination) === record.source;
    } catch {
      return false;
    }
  }
  return info.isDirectory() && directoryFingerprint(destination) === record.fingerprint;
}
