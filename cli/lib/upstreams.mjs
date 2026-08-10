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

function pinnedUpstreamSkillIsValid(source, expectedDigest) {
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
  const all = new Map();
  for (const plan of upstreamSkillPlans(catalog, Object.keys(catalog.skills.sessionHosts ?? {}))) {
    all.set(plan.name, plan);
  }
  for (const plan of upstreamSkillPlans(catalog, selection.requirements.sessionHosts)) {
    if (isCommandAvailable(plan.command, env)) selected.set(plan.name, plan);
  }
  for (const target of Object.values(state?.targets ?? {})) {
    for (const [name, record] of Object.entries(target.skills ?? {})) {
      if (record?.mode === "link" && all.has(name)) selected.set(name, all.get(name));
    }
  }
  return [...selected.values()];
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
