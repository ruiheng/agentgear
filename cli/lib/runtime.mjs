import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_MARKER = ".agentgear-runtime.json";
const STATE_VERSION = 1;
const MANAGED_SHIM_MARKER = "// agentgear-managed-runtime-shim";
const MANAGED_CMD_SHIM_MARKER = ":: agentgear-managed-runtime-shim";
const LINK_UNAVAILABLE_CODES = new Set(["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);
let temporarySequence = 0;
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
  return path.join(env.XDG_DATA_HOME || path.join(getHome(env), ".local", "share"), "agentgear");
}

export function getStateFile(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(getHome(env), ".local", "state");
  return path.join(stateHome, "agentgear", "installs.json");
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

function isLinkUnavailable(error) {
  return LINK_UNAVAILABLE_CODES.has(error?.code);
}

function directoryLinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function temporaryPath(directory, basename) {
  temporarySequence += 1;
  return path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${temporarySequence}.tmp`);
}

function createDirectoryLink(target, destination) {
  fs.symlinkSync(target, destination, directoryLinkType());
}

function removePathIfPresent(target) {
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function removePathQuietly(target) {
  try {
    removePathIfPresent(target);
  } catch {
    // Cleanup must not hide the operation that originally failed.
  }
}

function restoreTransactionEntries(entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    if (entry.hadOriginal && !entry.moved) continue;
    try {
      removePathIfPresent(entry.destination);
    } catch (error) {
      errors.push(`remove ${entry.destination}: ${error.message}`);
      continue;
    }
    if (!entry.moved || !entry.backup || !exists(entry.backup)) continue;
    try {
      fs.renameSync(entry.backup, entry.destination);
    } catch (error) {
      errors.push(`restore ${entry.destination}: ${error.message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function transactionBackupPath(destination) {
  let backup;
  do {
    backup = temporaryPath(path.dirname(destination), `${path.basename(destination)}.agentgear-backup`);
  } while (exists(backup));
  return backup;
}

export function createInstallTransaction() {
  const groups = [];
  let settled = false;

  return {
    replace(destinations, write) {
      if (settled) throw new Error("Installation transaction is already settled");
      const entries = [];
      try {
        for (const destination of [...new Set(destinations)]) {
          const entry = {
            destination,
            backup: null,
            hadOriginal: exists(destination),
            moved: false
          };
          entries.push(entry);
          if (!entry.hadOriginal) continue;
          entry.backup = transactionBackupPath(destination);
          fs.renameSync(destination, entry.backup);
          entry.moved = true;
        }
        const result = write();
        groups.push(entries);
        return result;
      } catch (error) {
        try {
          restoreTransactionEntries(entries);
        } catch (restoreError) {
          error.message += `; additionally failed to restore installation paths: ${restoreError.message}`;
        }
        throw error;
      }
    },

    rollback() {
      if (settled) return;
      settled = true;
      const errors = [];
      for (const entries of [...groups].reverse()) {
        try {
          restoreTransactionEntries(entries);
        } catch (error) {
          errors.push(error.message);
        }
      }
      groups.length = 0;
      if (errors.length > 0) throw new Error(errors.join("; "));
    },

    commit() {
      if (settled) return;
      settled = true;
      for (const entries of groups) {
        for (const entry of entries) {
          if (entry.moved && entry.backup) removePathQuietly(entry.backup);
        }
      }
      groups.length = 0;
    }
  };
}

function runtimeLinksSupported(dataRoot, target) {
  const probe = temporaryPath(dataRoot, "runtime-link-probe");
  try {
    createDirectoryLink(target, probe);
    return true;
  } catch (error) {
    if (isLinkUnavailable(error)) return false;
    throw error;
  } finally {
    removePathIfPresent(probe);
  }
}

function isManagedRuntimeShim(destination) {
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  try {
    return fs.readFileSync(destination, "utf8").startsWith(`#!/usr/bin/env node\n${MANAGED_SHIM_MARKER}\n`);
  } catch {
    return false;
  }
}

function commandShimPath(destination) {
  return `${destination}.cmd`;
}

function isManagedCommandShim(destination) {
  const commandShim = commandShimPath(destination);
  const info = fs.lstatSync(commandShim, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  try {
    return fs.readFileSync(commandShim, "utf8").startsWith(`${MANAGED_CMD_SHIM_MARKER}\r\n`);
  } catch {
    return false;
  }
}

function runtimeShimSource(command, modulePath) {
  return [
    "#!/usr/bin/env node",
    MANAGED_SHIM_MARKER,
    "",
    "(async () => {",
    '  const { spawnSync } = await import("node:child_process");',
    `  const result = spawnSync(process.execPath, [${JSON.stringify(modulePath)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
    "  if (result.error) {",
    `    process.stderr.write(${JSON.stringify(`${command}: `)} + result.error.message + "\\n");`,
    "    process.exitCode = 1;",
    "  } else {",
    "    process.exitCode = result.status ?? 1;",
    "  }",
    "})().catch(error => {",
    `  process.stderr.write(${JSON.stringify(`${command}: `)} + (error?.message ?? String(error)) + "\\n");`,
    "  process.exitCode = 1;",
    "});"
  ].join("\n") + "\n";
}

function writeRuntimeShim(destination, command, modulePath) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = temporaryPath(path.dirname(destination), path.basename(destination));
  try {
    fs.writeFileSync(temporary, runtimeShimSource(command, modulePath), { mode: 0o755 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    removePathIfPresent(temporary);
    throw error;
  }
  fs.chmodSync(destination, 0o755);
}

function assertWindowsCommandShimCanBeManaged(destination, force) {
  if (process.platform !== "win32") return;
  const commandShim = commandShimPath(destination);
  if (exists(commandShim) && !force && !isManagedCommandShim(destination)) {
    throw new Error(`Refusing to replace unmanaged command shim: ${commandShim}`);
  }
}

function writeWindowsCommandShim(destination) {
  if (process.platform !== "win32") return;
  const commandShim = commandShimPath(destination);
  removePathIfPresent(commandShim);
  const temporary = temporaryPath(path.dirname(commandShim), path.basename(commandShim));
  const source = [
    MANAGED_CMD_SHIM_MARKER,
    "@echo off",
    `node "%~dp0${path.basename(destination)}" %*`
  ].join("\r\n") + "\r\n";
  try {
    fs.writeFileSync(temporary, source);
    fs.renameSync(temporary, commandShim);
  } catch (error) {
    removePathIfPresent(temporary);
    throw error;
  }
}

function stripWindowsLinkNamespace(candidate) {
  let normalized = candidate;
  if (process.platform !== "win32") return normalized;

  const uncPrefix = "\\\\?\\UNC\\";
  const win32DevicePrefix = "\\\\?\\";
  const ntDevicePrefix = "\\??\\";
  if (normalized.startsWith(uncPrefix)) {
    normalized = `\\\\${normalized.slice(uncPrefix.length)}`;
  } else if (normalized.startsWith(win32DevicePrefix)) {
    normalized = normalized.slice(win32DevicePrefix.length);
  } else if (normalized.startsWith(ntDevicePrefix)) {
    normalized = normalized.slice(ntDevicePrefix.length);
  }
  return normalized;
}

function normalizeLinkPath(candidate) {
  return path.resolve(stripWindowsLinkNamespace(candidate));
}

function realpathIfExists(candidate) {
  try {
    return normalizeLinkPath(fs.realpathSync(candidate));
  } catch {
    return null;
  }
}

function pathsReferToSameLocation(left, right) {
  const normalizedLeft = normalizeLinkPath(left);
  const normalizedRight = normalizeLinkPath(right);
  if (normalizedLeft === normalizedRight) return true;
  const realLeft = realpathIfExists(normalizedLeft);
  const realRight = realpathIfExists(normalizedRight);
  return Boolean(realLeft && realRight && realLeft === realRight);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function pathIsInsideOrEqual(parent, candidate) {
  return path.resolve(parent) === path.resolve(candidate) || pathIsInside(parent, candidate);
}

function pathWithoutRelativeSuffix(candidate, relativePath) {
  if (relativePath === "") return candidate;
  let result = candidate;
  for (const component of relativePath.split(path.sep).reverse()) {
    if (path.basename(result) !== component) return null;
    result = path.dirname(result);
  }
  return result;
}

function sharedRuntimeTargetMatches(candidate, target, sharedRoot) {
  const normalizedCandidate = normalizeLinkPath(candidate);
  const normalizedTarget = normalizeLinkPath(target);
  if (normalizedCandidate === normalizedTarget) return true;

  const normalizedSharedRoot = normalizeLinkPath(sharedRoot);
  const relativePath = path.relative(normalizedSharedRoot, normalizedTarget);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) return false;

  // Do not realpath the candidate itself: doing so crosses `current` and
  // makes a physical release look like a stable current reference. Instead,
  // strip the expected suffix and compare only the data-root side of current.
  const candidateCurrent = pathWithoutRelativeSuffix(normalizedCandidate, relativePath);
  if (!candidateCurrent || path.basename(candidateCurrent) !== path.basename(normalizedSharedRoot)) {
    return false;
  }
  return pathsReferToSameLocation(path.dirname(candidateCurrent), path.dirname(normalizedSharedRoot));
}

function isStableSharedRuntimeRoot(candidate, dataRoot) {
  const currentPath = path.join(dataRoot, "current");
  if (sharedRuntimeTargetMatches(candidate, currentPath, currentPath)) return true;

  // A user can remove `agentgear/current` and its parent directory before a
  // later run reaches the same XDG location through a different symlink alias.
  // In that case the normal alias comparison cannot realpath the missing
  // `agentgear` component. Its existing XDG-data parent still establishes the
  // namespace, so recognize this one missing stable-path component as well.
  const normalizedCandidate = normalizeLinkPath(candidate);
  const normalizedCurrent = normalizeLinkPath(currentPath);
  if (path.basename(normalizedCandidate) !== path.basename(normalizedCurrent)) return false;
  const candidateParent = path.dirname(normalizedCandidate);
  const currentParent = path.dirname(normalizedCurrent);
  return path.basename(candidateParent) === path.basename(currentParent)
    && pathsReferToSameLocation(path.dirname(candidateParent), path.dirname(currentParent));
}

export function verifiedLegacyDevelopmentSourceRoots(state, env = process.env) {
  const dataRoot = getDataRoot(env);
  const roots = new Set();
  const targets = state?.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return [];

  for (const [targetRoot, targetRecord] of Object.entries(targets)) {
    const skills = targetRecord?.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) continue;
    for (const [skill, record] of Object.entries(skills)) {
      if (
        typeof skill !== "string"
        || skill.length === 0
        || path.basename(skill) !== skill
        || record?.mode !== "link"
        || typeof record.source !== "string"
      ) continue;

      const source = path.resolve(record.source);
      const skillsDirectory = path.dirname(source);
      if (path.basename(skillsDirectory) !== "skills" || path.basename(source) !== skill) continue;

      // Before state.commands existed, development installs linked both the
      // skill and commands directly to the checkout. A live, state-matching
      // skill link is the only evidence we retain for those command links.
      const destination = path.join(targetRoot, skill);
      if (!destinationMatchesRecord(destination, record)) continue;

      const checkoutRoot = path.dirname(skillsDirectory);
      // New development links record the stable shared runtime here. It is
      // not a legacy checkout and must never make an arbitrary current path
      // look installer-owned during migration or purge.
      if (isStableSharedRuntimeRoot(checkoutRoot, dataRoot)) continue;
      roots.add(checkoutRoot);
    }
  }
  return [...roots];
}

function isManagedCurrentLink(currentPath, dataRoot) {
  const info = fs.lstatSync(currentPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;

  const releasesRoot = path.join(dataRoot, "releases");
  try {
    // `current` and `releases` must be compared in the same namespace.  An
    // XDG data directory may itself be reached through a symlink.
    const target = normalizeLinkPath(fs.realpathSync(currentPath));
    const managedRoot = normalizeLinkPath(fs.realpathSync(releasesRoot));
    return pathIsInside(managedRoot, target);
  } catch {
    // Preserve recovery of a dangling, but lexically managed, `current` link.
    // Its target cannot be canonicalized because the old release is absent.
    const target = resolvedLinkTarget(currentPath);
    if (!target) return false;
    const normalizedReleasesRoot = normalizeLinkPath(releasesRoot);
    if (pathIsInside(normalizedReleasesRoot, target)) return true;

    // A prior invocation may have reached the same XDG data directory through
    // another symlink alias. The missing release itself cannot be realpathed,
    // but its `releases` parent still can.
    return pathsReferToSameLocation(path.dirname(target), normalizedReleasesRoot);
  }
}

function resolvedLinkTarget(linkPath) {
  try {
    const target = stripWindowsLinkNamespace(fs.readlinkSync(linkPath));
    return normalizeLinkPath(path.resolve(path.dirname(linkPath), target));
  } catch {
    return null;
  }
}

export function linkTargetsPath(linkPath, target) {
  const info = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  return resolvedLinkTarget(linkPath) === normalizeLinkPath(target);
}

function linkTargetsSharedRuntimePath(linkPath, target, sharedRoot) {
  const info = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;
  const linkedTarget = resolvedLinkTarget(linkPath);
  return Boolean(linkedTarget && sharedRuntimeTargetMatches(linkedTarget, target, sharedRoot));
}

function linkMatchesAnyTarget(linkPath, targets) {
  const info = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;

  const expectedPaths = new Set(targets.map(normalizeLinkPath));
  const expectedRealPaths = new Set();
  for (const target of targets) {
    try {
      expectedRealPaths.add(normalizeLinkPath(fs.realpathSync(target)));
    } catch {
      // A dangling target can still be matched by its stored link path below.
    }
  }

  const linkedTarget = resolvedLinkTarget(linkPath);
  if (linkedTarget && expectedPaths.has(linkedTarget)) return true;
  try {
    const actualRealPath = normalizeLinkPath(fs.realpathSync(linkPath));
    return expectedPaths.has(actualRealPath) || expectedRealPaths.has(actualRealPath);
  } catch {
    return false;
  }
}

function managedShimModulePath(destination) {
  if (!isManagedRuntimeShim(destination)) return null;
  try {
    const source = fs.readFileSync(destination, "utf8");
    const match = source.match(
      /spawnSync\(process\.execPath, \[("(?:\\.|[^"\\])*"), \.\.\.process\.argv\.slice\(2\)\]/
    );
    if (!match) return null;
    const modulePath = JSON.parse(match[1]);
    return typeof modulePath === "string" ? normalizeLinkPath(modulePath) : null;
  } catch {
    return null;
  }
}

function managedShimTargetsSharedRuntimePath(destination, target, sharedRoot) {
  const modulePath = managedShimModulePath(destination);
  return Boolean(modulePath && sharedRuntimeTargetMatches(modulePath, target, sharedRoot));
}

function recordedRuntimeCommand(state, destination, kind) {
  const record = state?.commands?.[destination];
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.kind !== kind || record.mode !== "link" || typeof record.target !== "string") return null;
  return record;
}

function isRecordedStableRuntimeCommand({ state, destination, kind, target, sharedRoot }) {
  // A removed `current` makes a stable command link dangling. Its lexical
  // target alone is not ownership evidence: an unrelated user link can use the
  // same path. Require the committed command record as well.
  const record = recordedRuntimeCommand(state, destination, kind);
  return Boolean(
    record
    && sharedRuntimeTargetMatches(record.target, target, sharedRoot)
    && linkTargetsSharedRuntimePath(destination, target, sharedRoot)
  );
}

export function recordRuntimeCommand(state, { destination, kind, mode, target }) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Cannot record runtime command without installation state");
  }
  if (!state.commands || typeof state.commands !== "object" || Array.isArray(state.commands)) {
    state.commands = {};
  }
  state.commands[destination] = {
    kind,
    mode,
    target: path.resolve(target),
    installedAt: new Date().toISOString()
  };
}

function isActiveSharedSkillConsumer(destination, record, target, sharedRoot) {
  // State establishes ownership, but only the link's lexical target tells us
  // whether publishing `current` can affect this destination. A stale state
  // entry (or a link pinned to an old physical release) must not block an
  // otherwise safe publication.
  return record?.mode === "link" && linkTargetsSharedRuntimePath(destination, target, sharedRoot);
}

function isActiveSharedRuntimeCommand(destination, target, sharedRoot) {
  return linkTargetsSharedRuntimePath(destination, target, sharedRoot)
    || managedShimTargetsSharedRuntimePath(destination, target, sharedRoot);
}

function requiredRuntimeFile(requirements, relativePath, consumer) {
  const current = requirements.get(relativePath) ?? new Set();
  current.add(consumer);
  requirements.set(relativePath, current);
}

function requiredRuntimeCommand(commands, relativePath, consumer) {
  const current = commands.get(relativePath) ?? new Set();
  current.add(consumer);
  commands.set(relativePath, current);
}

const STATIC_MODULE_SPECIFIER = /(?:^|[;\n])\s*(?:import\s+(?:[\w*$\s{},]+?\s+from\s+)?|export\s+(?:[\w*$\s{},]+?\s+from\s+)?)(["'])([^"']+)\1/gm;
const DOCUMENTED_RUNTIME_SCRIPT = /\bagentgear\s+run\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+([A-Za-z0-9.][A-Za-z0-9._/-]*\.(?:mjs|cjs|js))(?![A-Za-z0-9._/-])/g;
const DOCUMENTED_SKILL_REFERENCE = /(?:^|[^A-Za-z0-9._/-])((?:\.\/)?references\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md)(?![A-Za-z0-9._/-])/gm;

function documentedSkillRuntimeRequirements(snapshotRoot, skill) {
  const skillRoot = path.resolve(snapshotRoot, "skills", skill);
  const documents = new Set();
  const scripts = new Set();
  const pending = ["SKILL.md"];
  const visited = new Set();

  while (pending.length > 0) {
    const relativeDocument = pending.pop();
    if (visited.has(relativeDocument)) continue;
    visited.add(relativeDocument);

    const documentPath = path.resolve(skillRoot, relativeDocument);
    let source;
    try {
      source = fs.readFileSync(documentPath, "utf8");
    } catch {
      // Referenced documents are recorded before they are read so the caller
      // reports a precise missing-payload error. SKILL.md itself is already
      // required separately by the caller.
      continue;
    }

    for (const match of source.matchAll(DOCUMENTED_RUNTIME_SCRIPT)) {
      const [, scriptSkill, script] = match;
      if (path.isAbsolute(script) || script.split(/[\\/]/).includes("..")) continue;
      scripts.add(path.join("skills", scriptSkill, "scripts", script));
    }
    for (const match of source.matchAll(DOCUMENTED_SKILL_REFERENCE)) {
      const reference = match[1];
      const referencedPath = path.resolve(path.dirname(documentPath), reference);
      if (!pathIsInside(skillRoot, referencedPath)) continue;
      const relativeReference = path.relative(skillRoot, referencedPath);
      if (visited.has(relativeReference)) continue;
      documents.add(relativeReference);
      pending.push(relativeReference);
    }
  }
  return {
    documents: [...documents].map(document => path.join("skills", skill, document)),
    scripts: [...scripts]
  };
}

function requireDocumentedSkillRuntimeRequirements(requirements, commands, snapshotRoot, skill, consumer) {
  const documented = documentedSkillRuntimeRequirements(snapshotRoot, skill);
  for (const document of documented.documents) {
    requiredRuntimeFile(requirements, document, consumer);
  }
  for (const script of documented.scripts) {
    requiredRuntimeCommand(commands, script, `${consumer} (documented by skills/${skill})`);
  }
}

function relativeModuleSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(STATIC_MODULE_SPECIFIER)) {
    const specifier = match[2];
    if (specifier.startsWith(".")) specifiers.add(specifier);
  }
  return specifiers;
}

function moduleDependencyErrors(snapshotRoot, entryRelativePath) {
  const visited = new Set();
  const errors = new Set();
  const root = path.resolve(snapshotRoot);

  const visit = relativePath => {
    const modulePath = path.resolve(root, relativePath);
    if (!pathIsInsideOrEqual(root, modulePath)) {
      errors.add(`${relativePath} resolves outside the staged runtime`);
      return;
    }
    const normalizedRelativePath = path.relative(root, modulePath);
    if (visited.has(normalizedRelativePath)) return;
    visited.add(normalizedRelativePath);

    const info = fs.statSync(modulePath, { throwIfNoEntry: false });
    if (!info?.isFile()) {
      errors.add(`${normalizedRelativePath} is missing or is not a file`);
      return;
    }

    let source;
    try {
      source = fs.readFileSync(modulePath, "utf8");
    } catch (error) {
      errors.add(`${normalizedRelativePath} cannot be read: ${error.message}`);
      return;
    }
    for (const specifier of relativeModuleSpecifiers(source)) {
      const dependencyPath = path.resolve(path.dirname(modulePath), specifier);
      if (!pathIsInsideOrEqual(root, dependencyPath)) {
        errors.add(`${normalizedRelativePath} imports ${specifier}, which resolves outside the staged runtime`);
        continue;
      }
      visit(path.relative(root, dependencyPath));
    }
  };

  visit(entryRelativePath);
  return [...errors];
}

export function validateSharedRuntimeConsumers({
  runtime,
  state,
  snapshotRoot = runtime?.root,
  env = process.env,
  installLauncher = false,
  installWorkflowHelpers = false,
  plannedSkills = []
}) {
  if (!snapshotRoot) return [];

  const requirements = new Map();
  const commands = new Map();
  const localBin = path.join(getHome(env), ".local", "bin");
  const launcher = path.join(localBin, "agentgear");
  const runtimeDataRoot = runtime?.dataRoot ?? getDataRoot(env);
  const stableSharedRoot = runtime?.sharedRoot ?? path.join(runtimeDataRoot, "current");
  const inspectSharedConsumers = Boolean(runtime?.sharedRoot)
    || isManagedCurrentLink(stableSharedRoot, runtimeDataRoot);
  const activeSharedConsumers = new Set();
  if (inspectSharedConsumers) {
    for (const [targetRoot, targetRecord] of Object.entries(state?.targets ?? {})) {
      for (const [skill, record] of Object.entries(targetRecord?.skills ?? {})) {
        const destination = path.join(targetRoot, skill);
        const sharedTarget = path.join(stableSharedRoot, "skills", skill);
        // Do not limit this check to the selected skills: a live, unselected
        // link to `current` would become dangling after publication. State alone
        // is not enough, though; a deleted project target no longer consumes the
        // shared runtime.
        if (!isActiveSharedSkillConsumer(destination, record, sharedTarget, stableSharedRoot)) continue;
        activeSharedConsumers.add(destination);
        requiredRuntimeFile(requirements, path.join("skills", skill, "SKILL.md"), destination);
        requireDocumentedSkillRuntimeRequirements(requirements, commands, snapshotRoot, skill, destination);
      }
    }

    const launcherTarget = path.join(stableSharedRoot, "bin", "agentgear.mjs");
    if (isActiveSharedRuntimeCommand(launcher, launcherTarget, stableSharedRoot)) {
      activeSharedConsumers.add(launcher);
      requiredRuntimeCommand(commands, path.join("bin", "agentgear.mjs"), launcher);
    }

    for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
      const helper = path.join(localBin, name);
      const helperTarget = path.join(stableSharedRoot, "skills", "agent-deck-workflow", "scripts", script);
      if (isActiveSharedRuntimeCommand(helper, helperTarget, stableSharedRoot)) {
        activeSharedConsumers.add(helper);
        requiredRuntimeCommand(commands, path.join("skills", "agent-deck-workflow", "scripts", script), helper);
      }
    }
  }

  for (const skill of plannedSkills) {
    if (typeof skill !== "string" || skill.length === 0) continue;
    const consumer = `planned skill: ${skill}`;
    requiredRuntimeFile(requirements, path.join("skills", skill, "SKILL.md"), consumer);
    requireDocumentedSkillRuntimeRequirements(requirements, commands, snapshotRoot, skill, consumer);
  }

  if (installLauncher) {
    const entry = runtime?.sharedRoot
      ? path.join("bin", "agentgear.mjs")
      : path.join("cli", "agentgear.mjs");
    requiredRuntimeCommand(commands, entry, `planned launcher: ${launcher}`);
  }
  if (installWorkflowHelpers) {
    for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
      requiredRuntimeCommand(
        commands,
        path.join("skills", "agent-deck-workflow", "scripts", script),
        `planned workflow helper: ${path.join(localBin, name)}`
      );
    }
  }

  const errors = [];
  if (!runtime?.sharedRoot && activeSharedConsumers.size > 0) {
    errors.push(
      `Cannot use copy fallback while shared runtime consumers remain: ${[...activeSharedConsumers].join(", ")}. `
      + "Restore directory-link support before retrying."
    );
  }
  for (const [relativePath, consumers] of requirements) {
    const info = fs.statSync(path.join(snapshotRoot, relativePath), { throwIfNoEntry: false });
    if (info?.isFile()) continue;
    errors.push(
      `Cannot publish shared runtime: ${[...consumers].join(", ")} requires ${relativePath}, which is missing from the staged snapshot.`
    );
  }
  for (const [entryRelativePath, consumers] of commands) {
    for (const error of moduleDependencyErrors(snapshotRoot, entryRelativePath)) {
      errors.push(
        `Cannot publish shared runtime: ${[...consumers].join(", ")} requires ${entryRelativePath}, but ${error}.`
      );
    }
  }
  return errors;
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

function removeManagedPath(kind, destination, print) {
  removePathIfPresent(destination);
  print(`removed ${kind}: ${destination}`);
}

function replaceCurrentLink(currentPath, target) {
  const parent = path.dirname(currentPath);
  const incoming = temporaryPath(parent, "current-next");
  let incomingExists = false;
  try {
    createDirectoryLink(target, incoming);
    incomingExists = true;
    if (!exists(currentPath)) {
      fs.renameSync(incoming, currentPath);
      incomingExists = false;
      return;
    }

    try {
      fs.renameSync(incoming, currentPath);
      incomingExists = false;
      return;
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }

    // Windows cannot always replace an existing junction in one rename. Keep
    // the old junction as a recoverable backup until the new one is in place.
    const backup = temporaryPath(parent, "current-previous");
    let backupExists = false;
    try {
      fs.renameSync(currentPath, backup);
      backupExists = true;
      fs.renameSync(incoming, currentPath);
      incomingExists = false;
    } catch (error) {
      if (backupExists && exists(backup) && !exists(currentPath)) {
        try {
          fs.renameSync(backup, currentPath);
          backupExists = false;
        } catch (restoreError) {
          error.message += `; additionally failed to restore the previous shared runtime: ${restoreError.message}`;
        }
      }
      throw error;
    }

    // This is post-commit housekeeping. Reporting it as a publish failure
    // would be misleading because `current` already points at the new runtime.
    if (backupExists) removePathQuietly(backup);
  } finally {
    if (incomingExists) removePathQuietly(incoming);
  }
}

export function stageRuntime({ sourceRoot, env = process.env }) {
  const dataRoot = getDataRoot(env);
  const releasesRoot = path.join(dataRoot, "releases");
  const packageJson = readJsonIfExists(path.join(sourceRoot, "package.json"), { version: "dev" });
  const releaseId = `${packageJson.version}-${Date.now()}-${crypto.randomUUID()}`;
  const releasePath = path.join(releasesRoot, releaseId);
  const currentPath = path.join(dataRoot, "current");

  fs.mkdirSync(releasesRoot, { recursive: true });
  const stagingPath = path.join(releasesRoot, `.${releaseId}.staging`);
  try {
    copyRuntime(sourceRoot, stagingPath);
    writeJsonAtomic(path.join(stagingPath, RUNTIME_MARKER), {
      schemaVersion: STATE_VERSION,
      releaseId,
      sourceRoot,
      installedAt: new Date().toISOString()
    });
    fs.renameSync(stagingPath, releasePath);
  } catch (error) {
    removePathIfPresent(stagingPath);
    throw error;
  }

  let linkSupported;
  try {
    linkSupported = runtimeLinksSupported(dataRoot, releasePath);
    if (linkSupported && exists(currentPath) && !isManagedCurrentLink(currentPath, dataRoot)) {
      throw new Error(`Refusing to replace unmanaged runtime path: ${currentPath}`);
    }
  } catch (error) {
    removePathIfPresent(releasePath);
    throw error;
  }
  return {
    dataRoot,
    root: releasePath,
    sharedRoot: linkSupported ? currentPath : null,
    id: releaseId,
    linkSupported
  };
}

export function publishRuntime(runtime) {
  if (!runtime.linkSupported || !runtime.sharedRoot) return { published: false };

  const currentPath = runtime.sharedRoot;
  const hadPrevious = exists(currentPath);
  if (hadPrevious && !isManagedCurrentLink(currentPath, runtime.dataRoot)) {
    throw new Error(`Refusing to replace unmanaged runtime path: ${currentPath}`);
  }
  const previousTarget = hadPrevious ? resolvedLinkTarget(currentPath) : null;
  if (hadPrevious && !previousTarget) {
    throw new Error(`Could not determine the current shared runtime target: ${currentPath}`);
  }
  replaceCurrentLink(currentPath, runtime.root);
  return { published: true, currentPath, previousTarget, hadPrevious, runtimeRoot: runtime.root };
}

export function rollbackRuntimePublication(publication) {
  if (!publication?.published) return;
  if (!linkMatchesAnyTarget(publication.currentPath, [publication.runtimeRoot])) return;
  if (publication.hadPrevious) {
    if (!publication.previousTarget) {
      throw new Error(`Cannot restore the previous shared runtime: ${publication.currentPath}`);
    }
    replaceCurrentLink(publication.currentPath, publication.previousTarget);
  } else {
    removePathIfPresent(publication.currentPath);
  }
}

export function discardRuntime(runtime) {
  if (!runtime?.root || !runtime?.id) return;
  if (!isManagedRuntimeRelease(runtime.root, runtime.id)) return;
  removePathIfPresent(runtime.root);
}

function launcherIsManaged(launcherPath, sourceRoot, dataRoot, state, legacySourceRoots = []) {
  if (isManagedRuntimeShim(launcherPath)) return true;
  const info = fs.lstatSync(launcherPath, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;

  const currentPath = path.join(dataRoot, "current");
  const managedLauncher = path.join(currentPath, "bin", "agentgear.mjs");
  const currentIsManaged = isManagedCurrentLink(currentPath, dataRoot);
  if (
    (currentIsManaged && linkTargetsSharedRuntimePath(launcherPath, managedLauncher, currentPath))
    || (
      !exists(currentPath)
      && isRecordedStableRuntimeCommand({
        state,
        destination: launcherPath,
        kind: "launcher",
        target: managedLauncher,
        sharedRoot: currentPath
      })
    )
  ) return true;

  const legacyLaunchers = legacySourceRoots
    .filter(root => typeof root === "string" && !isStableSharedRuntimeRoot(root, dataRoot))
    .map(root => path.join(root, "bin", "agentgear.mjs"));
  if (legacyLaunchers.length > 0 && linkMatchesAnyTarget(launcherPath, legacyLaunchers)) return true;

  let target;
  try {
    target = fs.realpathSync(launcherPath);
  } catch {
    return false;
  }

  if (currentIsManaged) {
    const managedTarget = realpathIfExists(managedLauncher);
    if (managedTarget && target === managedTarget) return true;
  }
  const sourceLauncher = realpathIfExists(path.join(sourceRoot, "bin", "agentgear.mjs"));
  return Boolean(sourceLauncher && target === sourceLauncher);
}

function installRuntimeCommand({
  command,
  kind,
  destination,
  linkTarget,
  modulePath,
  isManaged,
  force,
  print,
  transaction
}) {
  if (exists(destination) && !force && !isManaged(destination)) {
    throw new Error(`Refusing to replace unmanaged ${kind}: ${destination}`);
  }
  assertWindowsCommandShimCanBeManaged(destination, force);
  const install = () => {
    if (linkTarget) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let linked = false;
      try {
        fs.symlinkSync(linkTarget, destination);
        linked = true;
      } catch (error) {
        if (!isLinkUnavailable(error)) throw error;
        print(`links unavailable; installing ${kind} wrapper: ${destination}`);
      }
      if (linked) {
        writeWindowsCommandShim(destination);
        return "link";
      }
    }
    writeRuntimeShim(destination, command, linkTarget || modulePath);
    writeWindowsCommandShim(destination);
    return "shim";
  };

  const managedPaths = process.platform === "win32"
    ? [destination, commandShimPath(destination)]
    : [destination];
  if (transaction) return transaction.replace(managedPaths, install);

  for (const managedPath of managedPaths) removePathIfPresent(managedPath);
  try {
    return install();
  } catch (error) {
    for (const managedPath of managedPaths) removePathQuietly(managedPath);
    throw error;
  }
}

export function ensureLauncher({
  sourceRoot,
  runtime,
  state,
  legacySourceRoots = [],
  force,
  env = process.env,
  print,
  transaction
}) {
  const dataRoot = getDataRoot(env);
  const destination = path.join(getHome(env), ".local", "bin", "agentgear");
  const linkTarget = runtime.sharedRoot
    ? path.join(runtime.sharedRoot, "bin", "agentgear.mjs")
    : null;
  const mode = installRuntimeCommand({
    command: "agentgear",
    kind: "launcher",
    destination,
    linkTarget,
    modulePath: path.join(runtime.root, "cli", "agentgear.mjs"),
    isManaged: candidate => launcherIsManaged(
      candidate,
      sourceRoot,
      dataRoot,
      state,
      legacySourceRoots
    ),
    force,
    print,
    transaction
  });
  return {
    destination,
    kind: "launcher",
    mode,
    target: linkTarget || path.join(runtime.root, "cli", "agentgear.mjs")
  };
}

function helperIsManaged(
  destination,
  target,
  dataRoot,
  sourceRoot,
  state,
  legacySourceRoots,
  script
) {
  if (isManagedRuntimeShim(destination)) return true;
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info?.isSymbolicLink()) return false;

  const currentPath = path.join(dataRoot, "current");
  if (
    target
    && (
      (isManagedCurrentLink(currentPath, dataRoot)
        && linkTargetsSharedRuntimePath(destination, target, currentPath))
      || (
        !exists(currentPath)
        && isRecordedStableRuntimeCommand({
          state,
          destination,
          kind: "workflow helper",
          target,
          sharedRoot: currentPath
        })
      )
    )
  ) return true;

  const legacyHelpers = legacySourceRoots
    .filter(root => typeof root === "string" && !isStableSharedRuntimeRoot(root, dataRoot))
    .map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script));
  if (legacyHelpers.length > 0 && linkMatchesAnyTarget(destination, legacyHelpers)) return true;

  const managedReleaseHelpers = managedRuntimeReleases(dataRoot)
    .map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script));
  if (managedReleaseHelpers.length > 0 && linkMatchesAnyTarget(destination, managedReleaseHelpers)) return true;

  const sourceHelper = realpathIfExists(
    path.join(sourceRoot, "skills", "agent-deck-workflow", "scripts", script)
  );
  return Boolean(sourceHelper && linkMatchesAnyTarget(destination, [sourceHelper]));
}

export function ensureWorkflowHelpers({
  sourceRoot,
  runtime,
  state,
  legacySourceRoots = [],
  force,
  env = process.env,
  print,
  transaction
}) {
  const dataRoot = getDataRoot(env);
  const localBin = path.join(getHome(env), ".local", "bin");

  const helpers = [];
  for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
    const destination = path.join(localBin, name);
    const linkTarget = runtime.sharedRoot
      ? path.join(runtime.sharedRoot, "skills", "agent-deck-workflow", "scripts", script)
      : null;
    const modulePath = path.join(runtime.root, "skills", "agent-deck-workflow", "scripts", script);
    const mode = installRuntimeCommand({
      command: name,
      kind: "workflow helper",
      destination,
      linkTarget,
      modulePath,
      isManaged: candidate => helperIsManaged(
        candidate,
        linkTarget,
        dataRoot,
        sourceRoot,
        state,
        legacySourceRoots,
        script
      ),
      force,
      print,
      transaction
    });
    helpers.push({
      destination,
      kind: "workflow helper",
      mode,
      target: linkTarget || modulePath
    });
  }
  return helpers;
}

export function purgeManagedRuntime({
  legacySourceRoots = [],
  state,
  env = process.env,
  print
}) {
  const dataRoot = getDataRoot(env);
  const currentPath = path.join(dataRoot, "current");
  const releasesRoot = path.join(dataRoot, "releases");
  const releaseRoots = managedRuntimeReleases(dataRoot);
  const sourceRoots = [...new Set(legacySourceRoots
    .filter(candidate => typeof candidate === "string" && candidate.length > 0)
    .map(candidate => path.resolve(candidate))
    .filter(candidate => !isStableSharedRuntimeRoot(candidate, dataRoot)))];
  const currentIsManaged = isManagedCurrentLink(currentPath, dataRoot);
  const localBin = path.join(getHome(env), ".local", "bin");

  const launcherTargets = [
    ...sourceRoots.map(root => path.join(root, "bin", "agentgear.mjs")),
    ...releaseRoots.map(root => path.join(root, "bin", "agentgear.mjs"))
  ];
  if (currentIsManaged) launcherTargets.push(path.join(currentPath, "bin", "agentgear.mjs"));
  const launcher = path.join(localBin, "agentgear");
  const launcherTarget = path.join(currentPath, "bin", "agentgear.mjs");
  const launcherIsRecorded = !exists(currentPath) && isRecordedStableRuntimeCommand({
    state,
    destination: launcher,
    kind: "launcher",
    target: launcherTarget,
    sharedRoot: currentPath
  });
  if (linkMatchesAnyTarget(launcher, launcherTargets) || isManagedRuntimeShim(launcher) || launcherIsRecorded) {
    removeManagedPath("launcher", launcher, print);
  }
  if (isManagedCommandShim(launcher)) removeManagedPath("launcher command shim", commandShimPath(launcher), print);

  for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
    const helper = path.join(localBin, name);
    const targets = [
      ...sourceRoots.map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script)),
      ...releaseRoots.map(root => path.join(root, "skills", "agent-deck-workflow", "scripts", script))
    ];
    if (currentIsManaged) {
      targets.push(path.join(currentPath, "skills", "agent-deck-workflow", "scripts", script));
    }
    const helperTarget = path.join(currentPath, "skills", "agent-deck-workflow", "scripts", script);
    const helperIsRecorded = !exists(currentPath) && isRecordedStableRuntimeCommand({
      state,
      destination: helper,
      kind: "workflow helper",
      target: helperTarget,
      sharedRoot: currentPath
    });
    if (linkMatchesAnyTarget(helper, targets) || isManagedRuntimeShim(helper) || helperIsRecorded) {
      removeManagedPath("workflow helper", helper, print);
    }
    if (isManagedCommandShim(helper)) removeManagedPath("workflow helper command shim", commandShimPath(helper), print);
  }

  if (currentIsManaged) removeManagedPath("runtime link", currentPath, print);
  for (const releaseRoot of releaseRoots) {
    removeManagedPath("runtime release", releaseRoot, print);
  }

  removeEmptyDirectory(releasesRoot);
  removeEmptyDirectory(dataRoot);
}

export function removeInstallStateFile({ env = process.env, print }) {
  const stateFile = getStateFile(env);
  const info = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return;
  removeManagedPath("installation state", stateFile, print);
  removeEmptyDirectory(path.dirname(stateFile));
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

export function copyOrLinkSkill({ source, copySource = source, destination, link, print }) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (link) {
    try {
      fs.symlinkSync(source, destination, directoryLinkType());
      return { mode: "link" };
    } catch (error) {
      if (!isLinkUnavailable(error)) throw error;
      print(`links unavailable; copying skill instead: ${destination}`);
    }
  }
  fs.cpSync(copySource, destination, { recursive: true, preserveTimestamps: true });
  return { mode: "copy" };
}

export function destinationMatchesRecord(destination, record) {
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info) return false;
  if (record.mode === "link") {
    return typeof record.source === "string" && linkMatchesAnyTarget(destination, [record.source]);
  }
  return info.isDirectory() && directoryFingerprint(destination) === record.fingerprint;
}
