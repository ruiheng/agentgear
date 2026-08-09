import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upstreamSkillPlans } from "./catalog.mjs";

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

function runGit(argumentsList, env) {
  const result = childProcess.spawnSync("git", argumentsList, {
    encoding: "utf8",
    env,
    stdio: "pipe",
    windowsHide: true
  });
  if (result.error) {
    fail(`Could not run git while installing an upstream skill: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "git failed").trim();
    fail(`Could not install upstream skill with git: ${detail}`);
  }
  return String(result.stdout || "").trim();
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

function resolveSkillPath(checkout, skillPath) {
  const source = path.resolve(checkout, ...skillPath.split("/"));
  if (!pathInside(checkout, source)) {
    fail(`Unsafe upstream skill path: ${skillPath}`);
  }
  return source;
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

export function provisionUpstreamSkill({ plan, runtime, env = process.env }) {
  const destination = path.join(runtime.root, "skills", plan.name);
  if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false })) {
    fail(`Staged runtime already contains upstream skill destination: ${destination}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-upstream-"));
  try {
    const checkout = path.join(temporaryRoot, "checkout");
    runGit(
      ["clone", "--depth", "1", "--branch", plan.source.ref, plan.source.repository, checkout],
      env
    );
    const commit = runGit(["-C", checkout, "rev-parse", "HEAD"], env);
    if (commit !== plan.source.commit) {
      fail(
        `Upstream ${plan.upstream} ref ${plan.source.ref} resolved to ${commit}, `
        + `expected ${plan.source.commit}`
      );
    }

    const source = resolveSkillPath(checkout, plan.source.skillPath);
    validateRegularTree(source);
    const skillFile = path.join(source, "SKILL.md");
    const skillInfo = fs.lstatSync(skillFile, { throwIfNoEntry: false });
    if (!skillInfo?.isFile() || skillInfo.isSymbolicLink()) {
      fail(`Upstream skill requires a regular SKILL.md: ${skillFile}`);
    }
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
