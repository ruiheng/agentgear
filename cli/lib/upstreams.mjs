import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upstreamSkillPlans } from "./catalog.mjs";

const UPSTREAM_DIGEST_PREFIX = "sha256-v1:";
const UPSTREAM_DIGEST_HEADER = "agentgear-upstream-content-v1\0";

function fail(message) {
  throw new Error(message);
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function isCommandAvailable(command, env = process.env) {
  const extensions = process.platform === "win32" && !path.extname(command)
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(directory, command + extension), fs.constants.X_OK);
        return true;
      } catch {
        // Continue searching.
      }
    }
  }
  return false;
}

function runGit(argumentsList, env, { streamProgress = false } = {}) {
  const result = childProcess.spawnSync("git", argumentsList, {
    encoding: "utf8",
    env,
    stdio: streamProgress ? ["ignore", "pipe", "inherit"] : "pipe",
    windowsHide: true
  });
  if (result.status === 0) return String(result.stdout || "").trim();
  if (result.error) {
    fail(`Could not run git while installing an upstream skill: ${result.error.message}`);
  }
  const detail = String(result.stderr || result.stdout || "git failed").trim();
  fail(`Could not install upstream skill with git: ${detail}`);
}

function validateRegularTree(rootDir) {
  const rootInfo = fs.lstatSync(rootDir, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    fail(`Upstream skill path is missing or is not a directory: ${rootDir}`);
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`Upstream skill contains an unsupported symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      validateRegularTree(entryPath);
    } else if (!entry.isFile()) {
      fail(`Upstream skill contains an unsupported entry: ${entryPath}`);
    }
  }
}

export function upstreamSkillDigest(rootDir) {
  validateRegularTree(rootDir);
  const hash = crypto.createHash("sha256");
  hash.update(UPSTREAM_DIGEST_HEADER);

  const visit = (directory, relative = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      const portableRelative = entryRelative.split(path.sep).join("/");
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${portableRelative}\0`);
        visit(entryPath, entryRelative);
      } else {
        hash.update(`file\0${portableRelative}\0`);
        hash.update(fs.readFileSync(entryPath));
        hash.update("\0");
      }
    }
  };

  visit(rootDir);
  return `${UPSTREAM_DIGEST_PREFIX}${hash.digest("hex")}`;
}

function dataRootFor(env = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), ".local", "share"), "agentgear");
}

export function pinnedUpstreamSkillIsValid(source, expectedDigest) {
  try {
    const skillFile = path.join(source, "SKILL.md");
    const skillInfo = fs.lstatSync(skillFile, { throwIfNoEntry: false });
    return Boolean(
      skillInfo?.isFile()
      && !skillInfo.isSymbolicLink()
      && upstreamSkillDigest(source) === expectedDigest
    );
  } catch {
    return false;
  }
}

function digestHex(source) {
  return source.contentDigest.slice(UPSTREAM_DIGEST_PREFIX.length);
}

function upstreamPlanBySkill(catalog, skill) {
  for (const plan of upstreamSkillPlans(catalog, Object.keys(catalog.skills.sessionHosts ?? {}))) {
    if (plan.name === skill) return plan;
  }
  return null;
}

function manifestPath(candidate) {
  return path.join(candidate, ".agentgear-retrieved-skill.json");
}

export function retrievedSkillMaterializationRoot(dataRoot, plan) {
  return path.join(dataRoot, "retrieved-skills", plan.name, digestHex(plan.source));
}

function materializationManifest(plan) {
  return {
    schemaVersion: 1,
    name: plan.name,
    repository: plan.source.repository,
    ref: plan.source.ref,
    commit: plan.source.commit,
    contentDigest: plan.source.contentDigest,
    payload: "payload/SKILL.md"
  };
}

function retrievedSkillMaterializationInspection(candidate, plan) {
  try {
    const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) return { valid: false };
    const entries = fs.readdirSync(candidate, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    if (entries.length !== 2
      || entries[0].name !== ".agentgear-retrieved-skill.json"
      || !entries[0].isFile()
      || entries[0].isSymbolicLink()
      || entries[1].name !== "payload"
      || !entries[1].isDirectory()
      || entries[1].isSymbolicLink()) {
      return { valid: false };
    }
    const manifestInfo = fs.lstatSync(manifestPath(candidate), { throwIfNoEntry: false });
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) return { valid: false };
    const expected = materializationManifest(plan);
    const actual = JSON.parse(fs.readFileSync(manifestPath(candidate), "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return { valid: false };
    const payload = path.join(candidate, "payload");
    return {
      valid: pinnedUpstreamSkillIsValid(payload, plan.source.contentDigest),
      payload
    };
  } catch {
    return { valid: false };
  }
}

export function retrievedSkillMaterializationIsValid(candidate, plan) {
  return retrievedSkillMaterializationInspection(candidate, plan).valid;
}

function copyValidatedTree(source, destination, plan) {
  if (!pinnedUpstreamSkillIsValid(source, plan.source.contentDigest)) return false;
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  return pinnedUpstreamSkillIsValid(destination, plan.source.contentDigest);
}

export function verifiedRuntimeUpstreamSource(plan, runtimeRoots) {
  for (const runtimeRoot of runtimeRoots ?? []) {
    if (!runtimeRoot) continue;
    const catalogFile = path.join(runtimeRoot, "catalog", "skills.json");
    try {
      const info = fs.lstatSync(catalogFile, { throwIfNoEntry: false });
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
      if (!samePinnedSource(catalog.upstreams?.[plan.upstream], plan.source)) continue;
      const source = path.join(runtimeRoot, "skills", plan.name);
      if (pinnedUpstreamSkillIsValid(source, plan.source.contentDigest)) return source;
    } catch {
      // An immutable runtime is merely an optional cache candidate.
    }
  }
  return null;
}

export function upstreamResourceStatus({ catalog, skill, env = process.env, runtimeRoots = [] }) {
  const plan = upstreamPlanBySkill(catalog, skill);
  if (!plan) return null;
  const finalRoot = retrievedSkillMaterializationRoot(dataRootFor(env), plan);
  const finalInfo = fs.lstatSync(finalRoot, { throwIfNoEntry: false });
  if (finalInfo) {
    const inspection = retrievedSkillMaterializationInspection(finalRoot, plan);
    if (!inspection.valid) return { plan, state: "corrupt", path: finalRoot };
    return { plan, state: "retrieved", path: finalRoot, payload: inspection.payload };
  }
  const discovered = retrievedUpstreamSkillPlans(catalog, env);
  const prefix = `${path.join(dataRootFor(env), "retrieved-skills", plan.name)}${path.sep}`;
  const preserved = discovered.preserved.find(candidate => candidate === path.join(dataRootFor(env), "retrieved-skills", plan.name)
    || candidate.startsWith(prefix));
  if (preserved) return { plan, state: "corrupt", path: preserved };
  const runtimePayload = verifiedRuntimeUpstreamSource(plan, runtimeRoots);
  if (runtimePayload) return { plan, state: "runtime", path: runtimePayload, payload: runtimePayload };
  return { plan, state: "available", path: finalRoot };
}

export function retrieveUpstreamSkill({
  catalog,
  skill,
  env = process.env,
  runtimeRoots = [],
  print = () => {},
  provision = provisionUpstreamSkill,
  rename = fs.renameSync
}) {
  const plan = upstreamPlanBySkill(catalog, skill);
  if (!plan) return null;
  const dataRoot = dataRootFor(env);
  const finalRoot = retrievedSkillMaterializationRoot(dataRoot, plan);
  if (fs.existsSync(finalRoot) || fs.lstatSync(finalRoot, { throwIfNoEntry: false })) {
    if (!retrievedSkillMaterializationIsValid(finalRoot, plan)) {
      fail(`Retrieved upstream skill is unverifiable: ${finalRoot}; remove it manually before retrying.`);
    }
    return { plan, payload: path.join(finalRoot, "payload"), materialized: false };
  }

  fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
  const temporary = `${finalRoot}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.mkdirSync(temporary);
    const payload = path.join(temporary, "payload");
    const cached = verifiedRuntimeUpstreamSource(plan, runtimeRoots);
    if (cached) {
      if (!copyValidatedTree(cached, payload, plan)) fail(`Could not validate staged upstream skill: ${cached}`);
    } else {
      const runtime = { root: path.join(temporary, "runtime") };
      fs.mkdirSync(runtime.root);
      provision({ plan, runtime, previousRuntimeRoots: runtimeRoots, env, print });
      const staged = path.join(runtime.root, "skills", plan.name);
      if (!copyValidatedTree(staged, payload, plan)) fail(`Could not validate fetched upstream skill: ${plan.name}`);
      fs.rmSync(runtime.root, { recursive: true, force: true });
    }
    fs.writeFileSync(manifestPath(temporary), `${JSON.stringify(materializationManifest(plan), null, 2)}\n`);
    if (!retrievedSkillMaterializationIsValid(temporary, plan)) fail(`Could not verify retrieved upstream skill: ${temporary}`);
    try {
      rename(temporary, finalRoot);
    } catch (error) {
      if (!retrievedSkillMaterializationIsValid(finalRoot, plan)) throw error;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    return { plan, payload: path.join(finalRoot, "payload"), materialized: true };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function retrievedUpstreamSkillPlans(catalog, env = process.env) {
  const dataRoot = dataRootFor(env);
  const root = path.join(dataRoot, "retrieved-skills");
  const info = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!info) return { valid: [], preserved: [] };
  if (!info.isDirectory() || info.isSymbolicLink()) return { valid: [], preserved: [root] };
  const plans = new Map(upstreamSkillPlans(catalog, Object.keys(catalog.skills.sessionHosts ?? {})).map(plan => [plan.name, plan]));
  const valid = [];
  const preserved = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const plan = plans.get(entry.name);
    const nameRoot = path.join(root, entry.name);
    if (!plan || !entry.isDirectory() || entry.isSymbolicLink()) {
      preserved.push(nameRoot);
      continue;
    }
    for (const candidate of fs.readdirSync(nameRoot, { withFileTypes: true })) {
      const candidateRoot = path.join(nameRoot, candidate.name);
      if (candidate.name === digestHex(plan.source) && candidate.isDirectory() && !candidate.isSymbolicLink() && retrievedSkillMaterializationIsValid(candidateRoot, plan)) {
        valid.push({ plan, root: candidateRoot });
      } else {
        preserved.push(candidateRoot);
      }
    }
  }
  return { valid, preserved };
}

function resolveSkillPath(checkout, skillPath) {
  const source = path.resolve(checkout, ...skillPath.split("/"));
  if (!pathInside(checkout, source)) {
    fail(`Unsafe upstream skill path: ${skillPath}`);
  }
  return source;
}

function samePinnedSource(left, right) {
  return ["repository", "skillPath", "ref", "commit", "contentDigest"]
    .every(key => left?.[key] === right?.[key]);
}

function reusePinnedUpstreamSkill(plan, previousRuntimeRoots, destination) {
  for (const previousRuntimeRoot of previousRuntimeRoots ?? []) {
    if (!previousRuntimeRoot) continue;
    const catalogFile = path.join(previousRuntimeRoot, "catalog", "skills.json");
    const catalogInfo = fs.lstatSync(catalogFile, { throwIfNoEntry: false });
    if (!catalogInfo?.isFile() || catalogInfo.isSymbolicLink()) continue;
    let previousCatalog;
    try {
      previousCatalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    } catch {
      continue;
    }
    if (!samePinnedSource(previousCatalog.upstreams?.[plan.upstream], plan.source)) continue;
    const source = path.join(previousRuntimeRoot, "skills", plan.name);
    if (!pinnedUpstreamSkillIsValid(source, plan.source.contentDigest)) continue;
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    return true;
  }
  return false;
}

export function selectedUpstreamSkillPlans(catalog, selection, state, env = process.env) {
  const selected = new Map();
  const all = new Map(upstreamSkillPlans(catalog, Object.keys(catalog.skills.sessionHosts ?? {}))
    .map(plan => [plan.name, plan]));
  // A locally usable selected host may retain a verified copy in the staged
  // runtime. It remains prompt-only: no target exposure is implied.
  for (const plan of upstreamSkillPlans(catalog, selection?.requirements?.sessionHosts ?? [])) {
    if (isCommandAvailable(plan.command, env)) selected.set(plan.name, plan);
  }
  // Preserve an existing runtime consumer independently of current host
  // selection so a linked historical payload is never dropped unexpectedly.
  for (const target of Object.values(state?.targets ?? {})) {
    for (const [name, record] of Object.entries(target.skills ?? {})) {
      if (record?.mode === "link" && all.has(name)) selected.set(name, all.get(name));
    }
  }
  return [...selected.values()];
}

function removePath(candidate) {
  const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isSymbolicLink()) fs.unlinkSync(candidate);
  else fs.rmSync(candidate, { recursive: true, force: true });
}

function pruneEmptyRetrievedParents(candidate, root) {
  let current = path.dirname(candidate);
  while (path.resolve(current).startsWith(`${path.resolve(root)}${path.sep}`)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink() || fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

// Retrieved resources live in a separate ownership domain from installation
// state. Quarantine first so a failed deletion restores the exact candidate.
export function purgeRetrievedUpstreamSkills({ catalog, env = process.env, print = () => {}, rename = fs.renameSync, remove = removePath } = {}) {
  const plans = retrievedUpstreamSkillPlans(catalog, env);
  const root = path.join(dataRootFor(env), "retrieved-skills");
  const failures = [];
  for (const candidate of plans.valid) {
    const quarantine = path.join(
      path.dirname(candidate.root),
      `.${path.basename(candidate.root)}.agentgear-purge-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    try {
      rename(candidate.root, quarantine);
      try {
        remove(quarantine);
      } catch (error) {
        try {
          rename(quarantine, candidate.root);
        } catch (restoreError) {
          failures.push(`${candidate.root}: ${error.message}; restore failed: ${restoreError.message}`);
          continue;
        }
        failures.push(`${candidate.root}: ${error.message}`);
        continue;
      }
      print(`removed retrieved skill: ${candidate.root}`);
      pruneEmptyRetrievedParents(candidate.root, root);
    } catch (error) {
      failures.push(`${candidate.root}: ${error.message}`);
    }
  }
  for (const candidate of plans.preserved) print("preserved unverifiable retrieved skill: " + candidate);
  return {
    ...plans,
    failures,
    incomplete: plans.preserved.length > 0 || failures.length > 0
  };
}

export function selectedUpstreamSkillNames(catalog, selection) {
  return upstreamSkillPlans(catalog, selection.requirements.sessionHosts)
    .map(plan => plan.name);
}

export function provisionUpstreamSkill({
  plan,
  runtime,
  previousRuntimeRoots,
  env = process.env,
  print = () => {},
  runGitCommand = runGit
}) {
  const destination = path.join(runtime.root, "skills", plan.name);
  if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false })) {
    fail(`Staged runtime already contains upstream skill destination: ${destination}`);
  }

  print(`Upstream skill ${plan.name}: checking verified cache...`);
  if (reusePinnedUpstreamSkill(plan, previousRuntimeRoots, destination)) {
    print(`Upstream skill ${plan.name}: reused cached copy.`);
    return;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-upstream-"));
  try {
    const checkout = path.join(temporaryRoot, "checkout");
    const source = resolveSkillPath(checkout, plan.source.skillPath);
    fs.mkdirSync(checkout);

    print(
      `Upstream skill ${plan.name}: fetching ${plan.source.ref} `
      + "with a filtered, shallow Git fetch..."
    );
    runGitCommand(["-C", checkout, "init", "--quiet"], env);
    runGitCommand(["-C", checkout, "remote", "add", "origin", plan.source.repository], env);
    runGitCommand(["-C", checkout, "config", "remote.origin.promisor", "true"], env);
    runGitCommand(
      ["-C", checkout, "config", "remote.origin.partialclonefilter", "blob:none"],
      env
    );
    runGitCommand(
      [
        "-C", checkout,
        "-c", "protocol.version=2",
        "fetch", "--progress", "--depth", "1", "--no-tags", "--filter=blob:none",
        "--", "origin", plan.source.ref
      ],
      env,
      { streamProgress: true }
    );
    const commit = runGitCommand(["-C", checkout, "rev-parse", "FETCH_HEAD^{commit}"], env);
    if (commit !== plan.source.commit) {
      fail(
        `Upstream ${plan.upstream} ref ${plan.source.ref} resolved to ${commit}, `
        + `expected ${plan.source.commit}`
      );
    }

    print(`Upstream skill ${plan.name}: materializing ${plan.source.skillPath} only...`);
    runGitCommand(["-C", checkout, "update-ref", "HEAD", commit], env);
    runGitCommand(["-C", checkout, "sparse-checkout", "init", "--cone"], env);
    runGitCommand(
      ["-C", checkout, "sparse-checkout", "set", plan.source.skillPath],
      env,
      { streamProgress: true }
    );
    runGitCommand(
      ["-C", checkout, "reset", "--hard", "--quiet", commit],
      env,
      { streamProgress: true }
    );

    print(`Upstream skill ${plan.name}: verifying pinned content...`);
    if (!pinnedUpstreamSkillIsValid(source, plan.source.contentDigest)) {
      fail(
        `Upstream ${plan.upstream} content does not match catalog digest `
        + `${plan.source.contentDigest}`
      );
    }
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    print(`Upstream skill ${plan.name}: ready.`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
