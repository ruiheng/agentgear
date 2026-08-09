import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_MARKER = ".agentgear-runtime.json";
const MARKER_VERSION = 1;
const STATE_VERSION = 2;
const FINGERPRINT_PREFIX = "sha256-v1:";
const FINGERPRINT_HEADER = "agentgear-fingerprint-v1\0";
const FINGERPRINT_PATTERN = /^sha256-v1:[0-9a-f]{64}$/;
const SKILL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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

function getStateFile(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(getHome(env), ".local", "state");
  return path.join(stateHome, "agentgear", "installs.json");
}

export function computePaths(env = process.env) {
  const home = getHome(env);
  const dataRoot = path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "agentgear");
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  const localBin = path.join(home, ".local", "bin");
  const workflowHelpers = {};
  for (const name of Object.keys(WORKFLOW_HELPERS)) workflowHelpers[name] = path.join(localBin, name);
  return {
    home,
    dataRoot,
    releasesRoot: path.join(dataRoot, "releases"),
    currentPath: path.join(dataRoot, "current"),
    stateFile: path.join(stateHome, "agentgear", "installs.json"),
    localBin,
    launcher: path.join(localBin, "agentgear"),
    workflowHelpers
  };
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isValidReleaseId(releaseId) {
  return typeof releaseId === "string"
    && releaseId.length > 0
    && !releaseId.includes("/")
    && !releaseId.includes("\\")
    && !releaseId.includes("\0")
    && releaseId !== "."
    && releaseId !== "..";
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

function releaseIdForTarget(target, releasesRoot) {
  let directory = path.dirname(target);
  let releaseId = null;
  while (path.resolve(directory) !== path.resolve(releasesRoot)) {
    if (!pathIsInside(releasesRoot, directory)) return null;
    releaseId = path.basename(directory);
    directory = path.dirname(directory);
  }
  return releaseId;
}

function directChildReleaseId(candidate, releasesRoot) {
  if (path.resolve(path.dirname(candidate)) !== path.resolve(releasesRoot)) return null;
  const releaseId = path.basename(candidate);
  return isValidReleaseId(releaseId) ? releaseId : null;
}

function walkEntries(rootDir, relative = "") {
  const current = path.join(rootDir, relative);
  const entries = fs.readdirSync(current, { withFileTypes: true });
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
  hash.update(FINGERPRINT_HEADER);
  const entries = walkEntries(rootDir).sort((left, right) =>
    compareUtf8(left.relative.replaceAll(path.sep, "/"), right.relative.replaceAll(path.sep, "/")));
  for (const entry of entries) {
    hash.update(`${entry.type}\0`);
    hash.update(entry.relative.replaceAll(path.sep, "/"));
    hash.update("\0");
    if (entry.type === "file") {
      hash.update((fs.statSync(entry.path).mode & 0o777).toString(8));
      hash.update("\0");
      hash.update(fs.readFileSync(entry.path));
      hash.update("\0");
    } else if (entry.type === "link") {
      hash.update(resolvedLinkTarget(entry.path) ?? "");
      hash.update("\0");
    }
  }
  return `${FINGERPRINT_PREFIX}${hash.digest("hex")}`;
}

// Fingerprint of a generated command wrapper. The primary file and, on
// Windows, its `.cmd` companion form one indivisible virtual tree.
export function wrapperFingerprint(destination) {
  const hash = crypto.createHash("sha256");
  hash.update(FINGERPRINT_HEADER);
  const entries = [{ name: path.basename(destination), filePath: destination }];
  if (process.platform === "win32") {
    entries.push({ name: `${path.basename(destination)}.cmd`, filePath: commandShimPath(destination) });
  }
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const info = fs.statSync(entry.filePath);
    hash.update(`file\0${entry.name}\0`);
    hash.update((info.mode & 0o777).toString(8));
    hash.update("\0");
    hash.update(fs.readFileSync(entry.filePath));
    hash.update("\0");
  }
  return `${FINGERPRINT_PREFIX}${hash.digest("hex")}`;
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
      for (const groupsEntry of groups) {
        for (const entry of groupsEntry) {
          if (entry.moved && entry.backup) removePathQuietly(entry.backup);
        }
      }
      groups.length = 0;
    }
  };
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

export function resolvedLinkTarget(linkPath) {
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

function commandShimPath(destination) {
  return `${destination}.cmd`;
}

function writeWindowsCommandShim(destination) {
  if (process.platform !== "win32") return;
  const commandShim = commandShimPath(destination);
  removePathIfPresent(commandShim);
  const temporary = temporaryPath(path.dirname(commandShim), path.basename(commandShim));
  const source = [
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

function commandWrapperSource(command, modulePath) {
  return [
    "#!/usr/bin/env node",
    "",
    "(async () => {",
    '  const { spawnSync } = await import("node:child_process");',
    `  const result = spawnSync(process.execPath, [${JSON.stringify(modulePath)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
    "  if (result.error) {",
    `    process.stderr.write(${JSON.stringify(`${command}: `)} + result.error.message + "\\n");`,
    "    process.exitCode = 1;",
    "  } else if (result.signal) {",
    `    process.stderr.write(${JSON.stringify(`${command}: child terminated by `)} + result.signal + "\\n");`,
    "    process.exitCode = 1;",
    "  } else if (result.status === null || result.status === undefined) {",
    `    process.stderr.write(${JSON.stringify(`${command}: child ended without an exit status\\n`)});`,
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

function writeCommandWrapper(destination, command, modulePath) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = temporaryPath(path.dirname(destination), path.basename(destination));
  try {
    fs.writeFileSync(temporary, commandWrapperSource(command, modulePath), { mode: 0o755 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    removePathIfPresent(temporary);
    throw error;
  }
  fs.chmodSync(destination, 0o755);
}

export function commandEntries(env = process.env) {
  const paths = computePaths(env);
  const entries = [{
    command: "agentgear",
    kind: "launcher",
    destination: paths.launcher,
    relativeModule: path.join("bin", "agentgear.mjs")
  }];
  for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
    entries.push({
      command: name,
      kind: "workflow-helper",
      destination: paths.workflowHelpers[name],
      relativeModule: path.join("skills", "multi-agent-protocol", "scripts", script)
    });
  }
  return entries;
}

// Exact artifact ownership for a command destination and its stored record.
export function commandArtifactOwned(destination, record) {
  if (!record || !isPlainObject(record)) return false;
  if (process.platform === "win32") {
    if (record.mode !== "wrapper") return false;
    const primary = fs.lstatSync(destination, { throwIfNoEntry: false });
    const companion = fs.lstatSync(commandShimPath(destination), { throwIfNoEntry: false });
    if (!primary?.isFile() || primary.isSymbolicLink()) return false;
    if (!companion?.isFile() || companion.isSymbolicLink()) return false;
    return wrapperFingerprint(destination) === record.fingerprint;
  }
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info) return false;
  if (record.mode === "link") {
    return info.isSymbolicLink() && resolvedLinkTarget(destination) === normalizeLinkPath(record.target);
  }
  if (record.mode === "wrapper") {
    return info.isFile() && !info.isSymbolicLink() && wrapperFingerprint(destination) === record.fingerprint;
  }
  return false;
}

function commandArtifactState(destination, record) {
  if (process.platform === "win32") {
    const primary = fs.lstatSync(destination, { throwIfNoEntry: false });
    const companion = fs.lstatSync(commandShimPath(destination), { throwIfNoEntry: false });
    if (!primary && !companion) return "absent";
    return commandArtifactOwned(destination, record) ? "owned" : "unowned";
  }
  const info = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!info) return "absent";
  return commandArtifactOwned(destination, record) ? "owned" : "unowned";
}

export function checkCommandCollisions(state, env, installLauncher, installWorkflowHelpers, force) {
  const entries = commandEntries(env).filter(entry =>
    entry.kind === "launcher" ? installLauncher : installWorkflowHelpers);
  for (const entry of entries) {
    const record = state?.commands?.[entry.destination];
    if (commandArtifactState(entry.destination, record) === "unowned" && !force) {
      throw new Error(`Refusing to replace unmanaged ${entry.kind}: ${entry.destination}`);
    }
  }
}

export function installRuntimeCommand({
  command,
  kind,
  destination,
  runtime,
  mode,
  relativeModule,
  print,
  transaction,
  env
}) {
  const paths = computePaths(env);
  const modulePath = mode === "shared"
    ? path.join(paths.currentPath, relativeModule)
    : path.join(runtime.root, relativeModule);
  const linkTarget = mode === "shared" && process.platform !== "win32" ? modulePath : null;

  const install = () => {
    if (linkTarget) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let linked = false;
      try {
        fs.symlinkSync(linkTarget, destination, "file");
        linked = true;
      } catch (error) {
        if (!isLinkUnavailable(error)) throw error;
        print(`links unavailable; installing ${kind} wrapper: ${destination}`);
      }
      if (linked) {
        return { mode: "link", target: linkTarget };
      }
    }
    writeCommandWrapper(destination, command, modulePath);
    writeWindowsCommandShim(destination);
    return { mode: "wrapper", target: modulePath, fingerprint: wrapperFingerprint(destination) };
  };

  const managedPaths = process.platform === "win32"
    ? [destination, commandShimPath(destination)]
    : [destination];
  const result = transaction.replace(managedPaths, install);
  return { kind, ...result };
}

function verifyReleaseMarker(markerPath, releaseId) {
  const info = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return false;
  }
  if (!isPlainObject(marker)) return false;
  const keys = Object.keys(marker);
  return keys.length === 2
    && marker.schemaVersion === MARKER_VERSION
    && marker.releaseId === releaseId;
}

export function isReleaseSnapshot(contentRoot) {
  return verifyReleaseMarker(path.join(contentRoot, RUNTIME_MARKER), path.basename(contentRoot));
}

export function verifyRelease(releasePath, releaseId) {
  const info = fs.lstatSync(releasePath, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  return verifyReleaseMarker(path.join(releasePath, RUNTIME_MARKER), releaseId);
}

function markerShapedReleaseChildren(paths) {
  const info = fs.lstatSync(paths.releasesRoot, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) return [];
  return fs.readdirSync(paths.releasesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => verifyReleaseMarker(path.join(paths.releasesRoot, entry.name, RUNTIME_MARKER), entry.name))
    .map(entry => entry.name);
}

// Strict schema-v2 state grammar. Every mutating command validates before any
// filesystem mutation; `--force` is powerless at this gate.
export function validateStateGrammar(state, env = process.env) {
  const invalid = reason => ({ valid: false, reason });
  if (state === null || state === undefined) return { valid: true };
  const paths = computePaths(env);

  if (!isPlainObject(state)) return invalid("top-level value is not a plain object");
  const keys = Object.keys(state);
  if (keys.length !== 5
    || !["schemaVersion", "channel", "releases", "targets", "commands"].every(key => keys.includes(key))) {
    return invalid(`unexpected top-level fields: ${keys.join(", ")}`);
  }
  if (state.schemaVersion !== STATE_VERSION) {
    return invalid(`unsupported schemaVersion ${JSON.stringify(state.schemaVersion)}; only ${STATE_VERSION} is valid`);
  }
  if (!(state.channel === null || state.channel === "release" || state.channel === "development")) {
    return invalid(`invalid channel ${JSON.stringify(state.channel)}`);
  }
  if (!Array.isArray(state.releases)) return invalid("releases must be an array");
  if (state.releases.some(id => !isValidReleaseId(id))) {
    return invalid("release inventory contains an unsafe release ID");
  }
  const sortedReleases = [...state.releases].sort(compareUtf8);
  if (new Set(state.releases).size !== state.releases.length
    || sortedReleases.join("\0") !== state.releases.join("\0")) {
    return invalid("release IDs must be unique and sorted bytewise");
  }
  if (!isPlainObject(state.targets)) return invalid("targets must be a plain object");
  if (!isPlainObject(state.commands)) return invalid("commands must be a plain object");

  if (state.channel === null) {
    if (state.releases.length > 0
      || Object.keys(state.targets).length > 0
      || Object.keys(state.commands).length > 0) {
      return invalid("channel null requires an empty release inventory and empty records");
    }
  } else if (state.releases.length === 0) {
    return invalid("a non-null channel requires at least one release ID");
  }

  for (const [targetPath, targetRecord] of Object.entries(state.targets)) {
    if (!path.isAbsolute(targetPath) || path.resolve(targetPath) !== targetPath) {
      return invalid(`target path is not normalized absolute: ${targetPath}`);
    }
    if (!isPlainObject(targetRecord)
      || Object.keys(targetRecord).length !== 1
      || !isPlainObject(targetRecord.skills)) {
      return invalid(`invalid target record for ${targetPath}`);
    }
    const currentRoot = paths.currentPath;
    for (const [skill, record] of Object.entries(targetRecord.skills)) {
      if (!SKILL_KEY_PATTERN.test(skill)) return invalid(`invalid skill key: ${skill}`);
      if (!isPlainObject(record)) return invalid(`invalid skill record for ${skill}`);
      if (record.mode === "link") {
        const expectedSource = path.join(currentRoot, "skills", skill);
        if (Object.keys(record).length !== 2
          || typeof record.source !== "string"
          || normalizeLinkPath(record.source) !== record.source
          || record.source !== expectedSource) {
          return invalid(`linked skill source must be exactly ${expectedSource}`);
        }
      } else if (record.mode === "copy") {
        if (Object.keys(record).length !== 2
          || typeof record.fingerprint !== "string"
          || !FINGERPRINT_PATTERN.test(record.fingerprint)) {
          return invalid(`invalid copied-skill record for ${skill}`);
        }
      } else {
        return invalid(`unknown skill mode ${JSON.stringify(record.mode)} for ${skill}`);
      }
    }
  }

  const expectedKinds = new Map();
  expectedKinds.set(paths.launcher, "launcher");
  for (const [name, destination] of Object.entries(paths.workflowHelpers)) {
    expectedKinds.set(destination, "workflow-helper");
  }
  const commandModules = new Map();
  for (const entry of commandEntries(env)) commandModules.set(entry.destination, entry.relativeModule);
  for (const [destination, record] of Object.entries(state.commands)) {
    const expectedKind = expectedKinds.get(destination);
    if (!expectedKind) return invalid(`unknown command destination: ${destination}`);
    if (!isPlainObject(record)) return invalid(`invalid command record for ${destination}`);
    if (record.kind !== expectedKind) return invalid(`command kind mismatch for ${destination}`);
    const currentTarget = path.join(paths.currentPath, commandModules.get(destination));
    if (record.mode === "link") {
      if (process.platform === "win32") return invalid("linked commands are invalid on Windows");
      if (Object.keys(record).length !== 3 || typeof record.target !== "string") {
        return invalid(`invalid linked-command record for ${destination}`);
      }
      if (normalizeLinkPath(record.target) !== record.target || record.target !== currentTarget) {
        return invalid(`linked command target must be exactly ${currentTarget}`);
      }
    } else if (record.mode === "wrapper") {
      if (Object.keys(record).length !== 4
        || typeof record.target !== "string"
        || typeof record.fingerprint !== "string"
        || !FINGERPRINT_PATTERN.test(record.fingerprint)) {
        return invalid(`invalid wrapper-command record for ${destination}`);
      }
      if (normalizeLinkPath(record.target) !== record.target) {
        return invalid(`wrapper command target is not normalized: ${record.target}`);
      }
      const releaseId = releaseIdForTarget(record.target, paths.releasesRoot);
      if (record.target !== currentTarget
        && !(releaseId
          && state.releases.includes(releaseId)
          && record.target === path.join(paths.releasesRoot, releaseId, commandModules.get(destination)))) {
        return invalid(
          `wrapper command target must be exactly ${currentTarget} `
          + `or releases/<inventoried-id>/${commandModules.get(destination).split(path.sep).join("/")}`
        );
      }
    } else {
      return invalid(`unknown command mode ${JSON.stringify(record.mode)} for ${destination}`);
    }
  }
  return { valid: true };
}

function hasLinkedSkillRecords(state) {
  if (!state) return false;
  for (const targetRecord of Object.values(state.targets)) {
    for (const record of Object.values(targetRecord.skills ?? {})) {
      if (record?.mode === "link") return true;
    }
  }
  return false;
}

// Coherence gate for install, update, and agentgear-link. Runs after grammar
// validation and before the channel gate, staging, or any mutation.
export function checkStateCoherence(state, env = process.env) {
  const paths = computePaths(env);
  const currentExists = exists(paths.currentPath);
  const markerChildren = markerShapedReleaseChildren(paths);
  const inventory = state === null ? [] : state.releases;

  if (state === null) {
    if (currentExists || markerChildren.length > 0) {
      throw new Error(
        `Installation state is missing beside managed runtime data at ${paths.dataRoot}; `
        + "restore the state file or remove the managed runtime manually"
      );
    }
  } else {
    if (state.channel === null && (currentExists || markerChildren.length > 0)) {
      throw new Error(
        `Channel-null state beside managed runtime data at ${paths.dataRoot}; `
        + "restore the original environment or perform a clean reinstall"
      );
    }
    if (!exists(paths.dataRoot)
      && (hasLinkedSkillRecords(state) || Object.keys(state.commands).length > 0)) {
      throw new Error(
        `Installation state references the managed runtime but its data root is missing: ${paths.dataRoot}`
      );
    }
  }

  for (const releaseId of inventory) {
    const releasePath = path.join(paths.releasesRoot, releaseId);
    if (!verifyRelease(releasePath, releaseId)) {
      throw new Error(
        `Inventoried release is missing or mismatched: ${releasePath}; `
        + "restore it or run a full purge"
      );
    }
  }
  for (const releaseId of markerChildren) {
    if (!inventory.includes(releaseId)) {
      throw new Error(
        `Unrecorded marked release present (possible interrupted transaction): ${releaseId}; `
        + "manual cleanup required"
      );
    }
  }

  const check = checkCurrentForPublication(state, env);
  if (!check.ok) throw new Error(check.reason);
}

export function checkChannelGate(state, requestedChannel) {
  if (state === null || state.channel === null) return;
  if (state.channel !== requestedChannel) {
    throw new Error(
      `Refusing to switch channel from ${JSON.stringify(state.channel)} to `
      + `${JSON.stringify(requestedChannel)}; run agentgear uninstall --purge before changing channels`
    );
  }
}

// The stable current link is replaceable only when its lexical target is a
// direct child of the exact releases root and names an inventoried release or
// the pending staged release of the current transaction.
export function checkCurrentForPublication(state, env = process.env, pendingReleaseId = null) {
  const paths = computePaths(env);
  const info = fs.lstatSync(paths.currentPath, { throwIfNoEntry: false });
  if (!info) return { ok: true };
  if (!info.isSymbolicLink()) {
    return { ok: false, reason: `Refusing to replace unmanaged runtime path: ${paths.currentPath}` };
  }
  const target = resolvedLinkTarget(paths.currentPath);
  if (!target) {
    return { ok: false, reason: `Refusing to replace unmanaged runtime path: ${paths.currentPath}` };
  }
  const releaseId = directChildReleaseId(target, paths.releasesRoot);
  const inventory = state === null ? [] : state.releases;
  if (!releaseId || (!inventory.includes(releaseId) && releaseId !== pendingReleaseId)) {
    return { ok: false, reason: `Refusing to replace unmanaged runtime path: ${paths.currentPath}` };
  }
  if (exists(target)) {
    if (!verifyRelease(target, releaseId)) {
      return { ok: false, reason: `Managed runtime target is missing its marker: ${target}` };
    }
    return { ok: true };
  }
  if (inventory.includes(releaseId)) {
    return {
      ok: false,
      reason: `Managed runtime link is dangling because its inventoried release is absent: ${target}; `
        + "install, update, and agentgear-link cannot recover it (only full purge can)"
    };
  }
  return { ok: false, reason: `Refusing to replace unmanaged runtime path: ${paths.currentPath}` };
}

export function stageRuntime({ sourceRoot, env = process.env }) {
  const paths = computePaths(env);
  const packageJson = readJsonIfExists(path.join(sourceRoot, "package.json"), { version: "dev" });
  // Keep physical release paths compact: launchers and skill loaders often
  // resolve `current` and expose this basename in their context.
  const now = new Date();
  const releaseDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const releaseId = `${packageJson.version}-${releaseDate}-${crypto.randomBytes(6).toString("base64url")}`;
  if (!isValidReleaseId(releaseId)) {
    throw new Error(
      `Unsafe package version ${JSON.stringify(packageJson.version)} cannot form a release ID`
    );
  }
  const releasePath = path.join(paths.releasesRoot, releaseId);

  fs.mkdirSync(paths.releasesRoot, { recursive: true });
  const stagingPath = path.join(paths.releasesRoot, `.${releaseId}.staging`);
  try {
    copyRuntime(sourceRoot, stagingPath);
    writeJsonAtomic(path.join(stagingPath, RUNTIME_MARKER), {
      schemaVersion: MARKER_VERSION,
      releaseId
    });
    fs.renameSync(stagingPath, releasePath);
  } catch (error) {
    removePathIfPresent(stagingPath);
    throw error;
  }
  return {
    dataRoot: paths.dataRoot,
    root: releasePath,
    id: releaseId
  };
}

export function publishRuntime(runtime, state, env = process.env) {
  const paths = computePaths(env);
  const currentPath = paths.currentPath;
  const hadPrevious = exists(currentPath);
  const check = checkCurrentForPublication(state, env, runtime.id);
  if (!check.ok) throw new Error(check.reason);
  const previousTarget = hadPrevious ? resolvedLinkTarget(currentPath) : null;
  if (hadPrevious && !previousTarget) {
    throw new Error(`Could not determine the current shared runtime target: ${currentPath}`);
  }
  replaceCurrentLink(currentPath, runtime.root);
  return { published: true, currentPath, previousTarget, hadPrevious, runtimeRoot: runtime.root };
}

export function rollbackRuntimePublication(publication) {
  if (!publication?.published) return;
  if (resolvedLinkTarget(publication.currentPath) !== normalizeLinkPath(publication.runtimeRoot)) return;
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
  if (!verifyReleaseMarker(path.join(runtime.root, RUNTIME_MARKER), runtime.id)) return;
  removePathIfPresent(runtime.root);
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

export function probeDirectoryLinks(runtime, targets, development, env = process.env) {
  const paths = computePaths(env);
  // Development shared links need directory links at every selected
  // destination parent (the target root that will hold each skill link);
  // public release skills are copies, so only the data root's
  // current-publication capability decides the release mode.
  const parents = development
    ? [...new Set([paths.dataRoot, ...targets.map(target => target.root)])]
    : [paths.dataRoot];
  for (const parent of parents) fs.mkdirSync(parent, { recursive: true });
  const created = [];
  try {
    for (const parent of parents) {
      const probe = temporaryPath(parent, "runtime-link-probe");
      createDirectoryLink(runtime.root, probe);
      created.push(probe);
    }
    return true;
  } catch (error) {
    if (!isLinkUnavailable(error)) throw error;
    return false;
  } finally {
    for (const probe of created) removePathQuietly(probe);
  }
}

function stateHasSharedRecords(state, env) {
  if (state === null) return false;
  for (const targetRecord of Object.values(state.targets)) {
    for (const record of Object.values(targetRecord.skills ?? {})) {
      if (record?.mode === "link") return true;
    }
  }
  const currentPrefix = `${normalizeLinkPath(computePaths(env).currentPath)}${path.sep}`;
  for (const record of Object.values(state.commands)) {
    if (normalizeLinkPath(record.target).startsWith(currentPrefix)) return true;
  }
  return false;
}

export function chooseDeploymentMode({ runtime, targets, development, state, env = process.env, print }) {
  const shared = probeDirectoryLinks(runtime, targets, development, env);
  if (shared) return "shared";
  if (stateHasSharedRecords(state, env)) {
    throw new Error(
      "Cannot use copy fallback while shared runtime records remain; "
      + "run agentgear uninstall --purge before switching modes"
    );
  }
  print("directory links unavailable; using copy fallback for this invocation.");
  return "fallback";
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

// Returns "file" when every component of relativePath below root is a real
// directory and the leaf is a real regular file; "missing" when any component
// is absent; "invalid" when any component is a symlink/junction, the leaf is
// not a regular file, or the path escapes root. lstat is applied per
// component so an intermediate symlink can never redirect the walk outside
// the trusted snapshot root.
function regularFileStatusUnderRoot(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length === 0) return "file";
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!pathIsInsideOrEqual(resolvedRoot, current)) return "invalid";
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) return "missing";
    if (info.isSymbolicLink()) return "invalid";
    const isLeaf = index === parts.length - 1;
    if (isLeaf) return info.isFile() ? "file" : "invalid";
    if (!info.isDirectory()) return "invalid";
  }
  return "file";
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

    if (regularFileStatusUnderRoot(root, normalizedRelativePath) !== "file") {
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

function entrypointRelativeToSnapshot(target, paths) {
  const normalized = normalizeLinkPath(target);
  const current = normalizeLinkPath(paths.currentPath);
  if (pathIsInsideOrEqual(current, normalized)) return path.relative(current, normalized);
  const releaseId = releaseIdForTarget(normalized, paths.releasesRoot);
  if (releaseId) return path.relative(path.join(paths.releasesRoot, releaseId), normalized);
  return null;
}

export function validateSharedRuntimeConsumers({
  runtime,
  state,
  env = process.env,
  mode = "fallback",
  development = false,
  installLauncher = false,
  installWorkflowHelpers = false,
  plannedSkills = [],
  snapshotRoot = runtime?.root
}) {
  if (!snapshotRoot) return [];
  const paths = computePaths(env);

  const requirements = new Map();
  const commands = new Map();

  // Exact active linked-skill records: the state record and the live link
  // artifact must agree before the staged snapshot is required to serve them.
  for (const [targetRoot, targetRecord] of Object.entries(state?.targets ?? {})) {
    for (const [skill, record] of Object.entries(targetRecord?.skills ?? {})) {
      if (record?.mode !== "link") continue;
      const destination = path.join(targetRoot, skill);
      if (!linkTargetsPath(destination, record.source)) continue;
      requiredRuntimeFile(requirements, path.join("skills", skill, "SKILL.md"), destination);
      requireDocumentedSkillRuntimeRequirements(requirements, commands, snapshotRoot, skill, destination);
    }
  }

  // Planned shared skills apply only to development shared-mode installs.
  // Release-copy selections and developer copy fallback are not shared skills.
  if (development && mode === "shared") {
    for (const skill of plannedSkills) {
      if (typeof skill !== "string" || skill.length === 0) continue;
      const consumer = `planned skill: ${skill}`;
      requiredRuntimeFile(requirements, path.join("skills", skill, "SKILL.md"), consumer);
      requireDocumentedSkillRuntimeRequirements(requirements, commands, snapshotRoot, skill, consumer);
    }
  }

  // Active commands whose exact record and artifact agree keep their entrypoint
  // requirements, whether they target `current` or a physical release.
  for (const [destination, record] of Object.entries(state?.commands ?? {})) {
    if (!commandArtifactOwned(destination, record)) continue;
    const relative = entrypointRelativeToSnapshot(record.target, paths);
    if (!relative) continue;
    requiredRuntimeCommand(commands, relative, destination);
  }

  if (installLauncher) {
    requiredRuntimeCommand(commands, path.join("bin", "agentgear.mjs"), `planned launcher: ${paths.launcher}`);
  }
  if (installWorkflowHelpers) {
    for (const [name, script] of Object.entries(WORKFLOW_HELPERS)) {
      requiredRuntimeCommand(
        commands,
        path.join("skills", "multi-agent-protocol", "scripts", script),
        `planned workflow helper: ${paths.workflowHelpers[name]}`
      );
    }
  }

  const errors = [];
  for (const [relativePath, consumers] of requirements) {
    if (regularFileStatusUnderRoot(snapshotRoot, relativePath) === "file") continue;
    errors.push(
      `Cannot publish shared runtime: ${[...consumers].join(", ")} requires ${relativePath}, which is missing from the staged snapshot or is not a regular file.`
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

export function copyOrLinkSkill({ source, copySource = source, destination, link, print }) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (link) {
    try {
      fs.symlinkSync(source, destination, directoryLinkType());
      return { mode: "link" };
    } catch (error) {
      if (link === "strict" || !isLinkUnavailable(error)) throw error;
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
    return typeof record.source === "string"
      && info.isSymbolicLink()
      && resolvedLinkTarget(destination) === normalizeLinkPath(record.source);
  }
  if (record.mode === "copy") {
    return info.isDirectory()
      && !info.isSymbolicLink()
      && directoryFingerprint(destination) === record.fingerprint;
  }
  return false;
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

export function addReleaseToInventory(state, releaseId) {
  if (state.releases.includes(releaseId)) return;
  state.releases.push(releaseId);
  state.releases.sort(compareUtf8);
}

export function removeEmptyDirectory(directory) {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function removeManagedPath(kind, destination, print) {
  removePathIfPresent(destination);
  print(`removed ${kind}: ${destination}`);
}

function currentPurgeOwned(currentPath, inventory, env) {
  const paths = computePaths(env);
  const info = fs.lstatSync(currentPath, { throwIfNoEntry: false });
  if (!info) return true;
  if (!info.isSymbolicLink()) return false;
  const target = resolvedLinkTarget(currentPath);
  if (!target) return false;
  const releaseId = directChildReleaseId(target, paths.releasesRoot);
  return Boolean(releaseId && inventory.includes(releaseId));
}

// Non-destructive full-purge preflight. Returns the messages to report and
// whether every recorded release and `current` are purge-owned. Run before
// removing any external artifact so a runtime ambiguity preserves everything.
export function preflightRuntimePurge({ state, env = process.env }) {
  const paths = computePaths(env);
  const inventory = state?.releases ?? [];
  const messages = [];
  let ok = true;
  for (const releaseId of inventory) {
    const releasePath = path.join(paths.releasesRoot, releaseId);
    if (!exists(releasePath)) continue;
    if (!verifyRelease(releasePath, releaseId)) {
      messages.push(`preserved mismatched release: ${releasePath}`);
      ok = false;
    }
  }
  if (exists(paths.currentPath) && !currentPurgeOwned(paths.currentPath, inventory, env)) {
    messages.push(`preserved ambiguous runtime path: ${paths.currentPath}`);
    ok = false;
  }
  return { ok, messages };
}

// Full purge teardown. Returns true only when `current` is gone and every
// recorded release is absent or was removed, so the caller may then remove
// state. Any ambiguity preserves everything and keeps state.
export function purgeManagedRuntime({ state, env = process.env, print }) {
  const paths = computePaths(env);
  const inventory = state?.releases ?? [];

  const preflight = preflightRuntimePurge({ state, env });
  for (const message of preflight.messages) print(message);
  if (!preflight.ok) {
    print("Purge incomplete: runtime ambiguity; manual cleanup required.");
    return false;
  }

  for (const [destination, record] of Object.entries(state?.commands ?? {})) {
    if (commandArtifactOwned(destination, record)) {
      removeManagedPath(record.kind, destination, print);
      if (process.platform === "win32") {
        removeManagedPath(`${record.kind} companion`, commandShimPath(destination), print);
      }
    } else {
      print(`preserved unverifiable ${record.kind}: ${destination}`);
    }
  }

  if (exists(paths.currentPath)) {
    removeManagedPath("runtime link", paths.currentPath, print);
  }
  for (const releaseId of inventory) {
    const releasePath = path.join(paths.releasesRoot, releaseId);
    if (!exists(releasePath)) continue;
    removeManagedPath("runtime release", releasePath, print);
  }
  removeEmptyDirectory(paths.releasesRoot);
  removeEmptyDirectory(paths.dataRoot);
  return true;
}

export function removeInstallStateFile({ env = process.env, print }) {
  const stateFile = getStateFile(env);
  const info = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return;
  removeManagedPath("installation state", stateFile, print);
  removeEmptyDirectory(path.dirname(stateFile));
}

export function readInstallState(env = process.env) {
  const stateFile = getStateFile(env);
  if (!exists(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

export function saveInstallState(state, env = process.env) {
  writeJsonAtomic(getStateFile(env), state);
}
