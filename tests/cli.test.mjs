import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childProcessOutcome, main, resolveRunSkill } from "../cli/agentgear.mjs";
import { main as sourceInstallMain } from "../cli/source-install.mjs";
import { loadCatalog } from "../cli/lib/catalog.mjs";
import {
  installSelection,
  permissionMigrationScopes,
  resolveTargetRoots,
  selected
} from "../cli/lib/installer.mjs";
import { parseOptions } from "../cli/lib/options.mjs";
import { createInstallTransaction, directoryFingerprint, stageRuntime, wrapperFingerprint } from "../cli/lib/runtime.mjs";
import { deleteSession } from "../cli/lib/session-hosts.mjs";
import {
  AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS,
  sessionNudgeOutcome,
  sessionNudgeSpec,
  THURBOX_NUDGE_PROCESS_TIMEOUT_MS
} from "../providers/session-hosts.mjs";
import {
  legacyAgyPathIdentity,
  validateLegacyAgyDiscovery
} from "../providers/legacy-agy-skill-discovery.mjs";
import {
  provisionUpstreamSkill as provisionPinnedUpstreamSkill,
  retrieveUpstreamSkill,
  retrievedSkillMaterializationRoot,
  upstreamSkillDigest
} from "../cli/lib/upstreams.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("session nudge provider maps the common wake request to each host CLI", () => {
  assert.equal(AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS, 15000);
  assert.equal(THURBOX_NUDGE_PROCESS_TIMEOUT_MS, 5000);
  assert.deepEqual(sessionNudgeSpec({
    host: "agent-deck", sessionId: "reviewer-1", message: "wake"
  }), {
    command: "agent-deck",
    timeoutMs: AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS,
    args: [
      "session", "send", "--json", "-defer-if-busy", "-defer-timeout", "5s",
      "-timeout", "5s", "reviewer-1", "wake"
    ]
  });
  assert.deepEqual(sessionNudgeSpec({
    host: "thurbox", sessionId: "reviewer-1", message: "wake"
  }), {
    command: "thurbox-cli",
    timeoutMs: THURBOX_NUDGE_PROCESS_TIMEOUT_MS,
    args: ["session", "send", "reviewer-1", "wake"]
  });
});

test("session nudge provider distinguishes unconfirmed agent-deck delivery", () => {
  const typed = sessionNudgeOutcome("agent-deck", {
    status: 1,
    stdout: JSON.stringify({ success: false, delivery: "typed", submitted: false }),
    stderr: "",
    error: null,
    signal: null,
    timedOut: false
  });
  assert.equal(typed.status, "unconfirmed");
  assert.match(typed.detail, /submission was not confirmed/);
  assert.equal(typed.error, null);

  const failed = sessionNudgeOutcome("agent-deck", {
    status: 1,
    stdout: JSON.stringify({ success: false, delivery: "typed_not_submitted", error: "not submitted" }),
    stderr: "",
    error: null,
    signal: null,
    timedOut: false
  });
  assert.deepEqual(failed, {
    status: "failed",
    scheme: "agent-deck",
    detail: null,
    error: "not submitted"
  });

  const unknown = sessionNudgeOutcome("agent-deck", {
    status: 0,
    stdout: JSON.stringify({ submitted: false }),
    stderr: "",
    error: null,
    signal: null,
    timedOut: false
  });
  assert.equal(unknown.status, "unconfirmed");
  assert.match(unknown.detail, /without a delivery verdict/);
});

test("agentgear run explains signal and nonzero child exits", () => {
  assert.deepEqual(childProcessOutcome({ status: null, signal: "SIGTERM" }, "workflow/send.mjs"), {
    exitCode: 1,
    diagnostic: "agentgear run: workflow/send.mjs terminated by SIGTERM"
  });
  assert.deepEqual(childProcessOutcome({ status: 7, signal: null }, "workflow/send.mjs"), {
    exitCode: 7,
    diagnostic: "agentgear run: workflow/send.mjs exited with code 7"
  });
});

function pathExists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function invoke(commandMain, argumentsList, env = {}) {
  const original = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    commandMain(argumentsList);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function run(argumentsList, env = {}) {
  const isSourceInstall = argumentsList[0] === "source-install";
  return invoke(isSourceInstall ? sourceInstallMain : main, isSourceInstall ? argumentsList.slice(1) : argumentsList, env);
}

async function checkoutRunner(checkout, environment) {
  const { main: checkoutMain } = await import(
    `${pathToFileURL(path.join(checkout, "cli", "agentgear.mjs")).href}?test=${Date.now()}`
  );
  const { main: checkoutSourceInstallMain } = await import(
    `${pathToFileURL(path.join(checkout, "cli", "source-install.mjs")).href}?test=${Date.now()}`
  );
  return argumentsList => {
    const isSourceInstall = argumentsList[0] === "source-install";
    return invoke(
      isSourceInstall ? checkoutSourceInstallMain : checkoutMain,
      isSourceInstall ? argumentsList.slice(1) : argumentsList,
      environment
    );
  };
}

function environmentFixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-cli-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  return {
    temporary,
    home,
    environment,
    dataRoot: path.join(environment.XDG_DATA_HOME, "agentgear"),
    stateFile: path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json"),
    localBin: path.join(home, ".local", "bin"),
    releasesRoot: path.join(environment.XDG_DATA_HOME, "agentgear", "releases")
  };
}

function readState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
}

function craftState(fixture, state) {
  fs.mkdirSync(path.dirname(fixture.stateFile), { recursive: true });
  fs.writeFileSync(fixture.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function spawnAgentgear(argumentsList, fixture, environment) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(rootDir, "bin", "agentgear.mjs"), ...argumentsList],
    { cwd: rootDir, encoding: "utf8", env: { ...process.env, ...environment } }
  );
}

function spawnAgentgearSourceInstall(argumentsList, fixture, environment) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(rootDir, "bin", "agentgear-source-install.mjs"), ...argumentsList],
    { cwd: rootDir, encoding: "utf8", env: { ...process.env, ...environment } }
  );
}

function writeExecutable(directory, name) {
  const filePath = process.platform === "win32"
    ? path.join(directory, `${name}.cmd`)
    : path.join(directory, name);
  if (process.platform === "win32") {
    fs.writeFileSync(filePath, "@echo off\r\nexit /b 0\r\n");
  } else {
    fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeNodeExecutable(directory, name, source) {
  const filePath = process.platform === "win32"
    ? path.join(directory, `${name}.cmd`)
    : path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(filePath, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`);
    fs.writeFileSync(path.join(directory, `${name}.cjs`), source);
  } else {
    fs.writeFileSync(filePath, `#!${process.execPath}\n${source}`);
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeWaypostExecutable(directory, output = "waypost 0.6.0", status = 0) {
  return writeNodeExecutable(directory, "waypost", `
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(`${output}\n`)});
  process.exit(${status});
}
process.exit(0);
`);
}

test("canonical fingerprints match fixed golden vectors on POSIX filesystems", t => {
  if (process.platform === "win32") {
    // Windows reports different mode bits and wrapper fingerprints require the
    // .cmd companion; the Windows contract is covered by the
    // platform-specific serialization test below.
    t.skip("POSIX mode semantics do not apply on Windows");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-fingerprint-test-"));
  try {
    const fixtureDir = path.join(temporary, "fixture");
    fs.mkdirSync(path.join(fixtureDir, "empty"), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "a.txt"), "hello\n");
    fs.chmodSync(path.join(fixtureDir, "a.txt"), 0o644);
    assert.equal(
      directoryFingerprint(fixtureDir),
      "sha256-v1:dd29a693f6e148f9d117314be34acbaee711c066a81856ff1ea512fbfe8f1605"
    );

    const wrapper = path.join(temporary, "wrapper");
    fs.writeFileSync(wrapper, "#!/usr/bin/env node\nconsole.log(\"wrapper\");\n");
    fs.chmodSync(wrapper, 0o755);
    assert.equal(
      wrapperFingerprint(wrapper),
      "sha256-v1:34056a26a9a9cd99e821df0292c0efe7a45772d23684e872d2003f34eb346aa3"
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows wrapper fingerprints cover the primary file and .cmd companion", t => {
  if (process.platform !== "win32") {
    t.skip("Windows-only wrapper group contract");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-fingerprint-test-"));
  try {
    const wrapper = path.join(temporary, "agentgear");
    fs.writeFileSync(wrapper, "#!/usr/bin/env node\nconsole.log(\"primary\");\n");
    fs.writeFileSync(`${wrapper}.cmd`, "@echo off\r\nnode \"%~dp0agentgear\" %*\r\n");
    const first = wrapperFingerprint(wrapper);
    const second = wrapperFingerprint(wrapper);
    assert.equal(first, second);
    assert.match(first, /^sha256-v1:[0-9a-f]{64}$/);

    fs.appendFileSync(`${wrapper}.cmd`, "\r\n");
    assert.notEqual(wrapperFingerprint(wrapper), first);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("an unsafe package version cannot escape the releases directory", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const packageJsonPath = path.join(checkout, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "../escaped";
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const runCheckout = await checkoutRunner(checkout, fixture.environment);

    for (const argumentsList of [
      ["source-install", "--skill", "handoff", "--target", "general"],
      ["install", "--skill", "handoff", "--target", "general"]
    ]) {
      assert.throws(
        () => runCheckout(argumentsList),
        /Unsafe package version/
      );
    }
    assert.equal(pathExists(fixture.dataRoot), false);
    assert.equal(pathExists(fixture.stateFile), false);
    assert.equal(pathExists(path.join(fixture.home, ".agents", "skills", "handoff")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("completeness rejects symlinked entrypoints and documents escaping the snapshot", async () => {
  const outside = path.join(os.tmpdir(), `agentgear-outside-${Date.now()}.mjs`);
  fs.writeFileSync(outside, "export const value = 1;\n");
  try {
    for (const [missing, replacement, errorPattern] of [
      ["bin/agentgear.mjs", outside, /bin[\\/]agentgear\.mjs is missing or is not a file/],
      ["skills/handoff/SKILL.md", outside, /Projected skill path is missing or unsafe/],
      ["cli/agentgear.mjs", outside, /cli[\\/]agentgear\.mjs is missing or is not a file/]
    ]) {
      const fixture = environmentFixture();
      const checkout = path.join(fixture.temporary, "checkout");
      try {
        fs.cpSync(rootDir, checkout, {
          recursive: true,
          filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
        });
        const targetPath = path.join(checkout, ...missing.split("/"));
        fs.rmSync(targetPath);
        fs.symlinkSync(replacement, targetPath, "file");
        const runCheckout = await checkoutRunner(checkout, fixture.environment);

        assert.throws(
          () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
          errorPattern
        );
        assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
        assert.equal(pathExists(fixture.stateFile), false);
        assert.equal(pathExists(path.join(fixture.home, ".agents", "skills", "handoff")), false);
      } finally {
        fs.rmSync(fixture.temporary, { recursive: true, force: true });
      }
    }

    // Symlinked ancestor directories are rejected too: a staged bin/ or
    // skills/ that is a link to an outside directory must not serve mutable
    // external content, even when the leaf is a regular file there.
    for (const [ancestor, leaf, errorPattern] of [
      ["bin", "bin/agentgear.mjs", /bin[\\/]agentgear\.mjs is missing or is not a file/],
      ["skills", "skills/handoff/SKILL.md", /Projected skill path is missing or unsafe/]
    ]) {
      const fixture = environmentFixture();
      const checkout = path.join(fixture.temporary, "checkout");
      const outsideDirectory = path.join(fixture.temporary, "outside-dir");
      try {
        fs.cpSync(rootDir, checkout, {
          recursive: true,
          filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
        });
        if (ancestor === "skills") {
          // The checkout guard validates every selected skill, so the outside
          // directory must carry the full skills tree for the selection.
          fs.cpSync(path.join(checkout, "skills"), outsideDirectory, { recursive: true });
        } else {
          fs.mkdirSync(path.join(outsideDirectory, path.dirname(leaf)), { recursive: true });
          fs.writeFileSync(path.join(outsideDirectory, leaf), "external content\n");
        }
        fs.rmSync(path.join(checkout, ancestor), { recursive: true, force: true });
        fs.symlinkSync(outsideDirectory, path.join(checkout, ancestor), "dir");
        const runCheckout = await checkoutRunner(checkout, fixture.environment);

        assert.throws(
          () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
          errorPattern
        );
        assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
        assert.equal(pathExists(fixture.stateFile), false);
      } finally {
        fs.rmSync(fixture.temporary, { recursive: true, force: true });
      }
    }

    // A dangling symlink is rejected the same way.
    const fixture = environmentFixture();
    const checkout = path.join(fixture.temporary, "checkout");
    try {
      fs.cpSync(rootDir, checkout, {
        recursive: true,
        filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
      });
      const targetPath = path.join(checkout, "bin", "agentgear.mjs");
      fs.rmSync(targetPath);
      fs.symlinkSync(path.join(fixture.temporary, "missing-module.mjs"), targetPath, "file");
      const runCheckout = await checkoutRunner(checkout, fixture.environment);
      assert.throws(
        () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
        /bin[\\/]agentgear\.mjs is missing or is not a file/
      );
    } finally {
      fs.rmSync(fixture.temporary, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("lists the catalog and builds every target layout", () => {
  run(["build"]);
  assert.deepEqual(Object.keys(loadCatalog(rootDir).targets.targets), ["general", "gemini", "agy", "claude", "kiro"]);
  for (const [target, directory] of [
    ["general", ".agents/skills"],
    ["gemini", ".gemini/skills"],
    ["agy", ".gemini/config/skills"],
    ["claude", ".claude/skills"],
    ["kiro", ".kiro/skills"]
  ]) {
    assert.equal(
      fs.existsSync(path.join(rootDir, "dist", target, directory, "handoff", "SKILL.md")),
      true
    );
  }
  for (const removedTarget of ["opencode", "antigravity"]) {
    assert.equal(fs.existsSync(path.join(rootDir, "dist", removedTarget)), false);
  }
});

test("general, Gemini, Agy, and Claude are the default skill targets", () => {
  const fixture = environmentFixture();
  try {
    const targets = resolveTargetRoots(loadCatalog(rootDir), parseOptions([]), fixture.environment);
    assert.deepEqual(targets, [
      {
        name: "general",
        root: path.join(fixture.home, ".agents", "skills")
      },
      {
        name: "gemini",
        root: path.join(fixture.home, ".gemini", "skills")
      },
      {
        name: "agy",
        root: path.join(fixture.home, ".gemini", "config", "skills")
      },
      {
        name: "claude",
        root: path.join(fixture.home, ".claude", "skills")
      }
    ]);

    const customRoot = path.join(fixture.temporary, "custom-skills");
    assert.deepEqual(
      resolveTargetRoots(
        loadCatalog(rootDir),
        parseOptions(["--dest", customRoot]),
        fixture.environment
      ),
      [{ name: "general", root: customRoot }]
    );

    const project = path.join(fixture.temporary, "project");
    assert.deepEqual(
      resolveTargetRoots(
        loadCatalog(rootDir),
        parseOptions(["--scope", "project", "--project", project]),
        fixture.environment
      ),
      [
        { name: "general", root: path.join(project, ".agents", "skills") },
        { name: "gemini", root: path.join(project, ".gemini", "skills") },
        { name: "claude", root: path.join(project, ".claude", "skills") }
      ]
    );
    assert.deepEqual(
      resolveTargetRoots(
        loadCatalog(rootDir),
        parseOptions(["--target", "agy", "--scope", "project", "--project", project]),
        fixture.environment
      ),
      [{ name: "agy", root: path.join(project, ".agents", "skills") }]
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("skill prefixes validate conflicts, syntax, and actual generated names", () => {
  const fixture = environmentFixture();
  const install = prefix => run([
    "install", "--skill", "handoff", "--target", "general", "--prefix", prefix, "--no-launcher"
  ], fixture.environment);
  try {
    for (const prefix of ["delegate", "delegate-code", "delegate-code-task"]) {
      assert.throws(() => install(prefix), /conflicts with known skill "delegate-code-task"/);
    }
    assert.throws(() => install("agent"), /known skill "agent-deck"/);
    assert.throws(() => install("coordinate"), /known skill "coordinate-design-spec"/);
    assert.throws(() => install("Acme"), /lowercase kebab-case/);
    assert.throws(
      () => install("a".repeat(57)),
      /Installed skill name .* exceeds 64 characters/
    );

    install("acme-tools");
    assert.equal(
      fs.existsSync(path.join(fixture.home, ".agents", "skills", "acme-tools-handoff")),
      true
    );
    assert.throws(
      () => run([
        "uninstall", "--skill", "handoff", "--target", "general", "--prefix", "acme-tools"
      ], fixture.environment),
      /--prefix is only valid with install and update/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }

  const boundaryFixture = environmentFixture();
  try {
    run([
      "install", "--skill", "handoff", "--target", "general",
      "--prefix", "a".repeat(56), "--no-launcher"
    ], boundaryFixture.environment);
    assert.equal(
      fs.existsSync(path.join(
        boundaryFixture.home,
        ".agents",
        "skills",
        `${"a".repeat(56)}-handoff`
      )),
      true
    );
  } finally {
    fs.rmSync(boundaryFixture.temporary, { recursive: true, force: true });
  }
});

test("prefixed release installs preserve canonical runtime addresses and one installation-wide name", () => {
  const fixture = environmentFixture();
  const target = path.join(fixture.home, ".agents", "skills");
  const inheritedTarget = path.join(fixture.home, ".claude", "skills");
  const unmanaged = path.join(target, "handoff");
  try {
    fs.mkdirSync(unmanaged, { recursive: true });
    fs.writeFileSync(path.join(unmanaged, "user.txt"), "keep\n");

    run([
      "install", "--skill", "handoff", "--target", "general", "--prefix", "acme", "--no-launcher"
    ], fixture.environment);

    const installed = path.join(target, "acme-handoff");
    const bootstrap = fs.readFileSync(path.join(installed, "SKILL.md"), "utf8");
    assert.match(bootstrap, /^name: acme-handoff$/m);
    assert.match(bootstrap, /agentgear skill get handoff/);
    assert.equal(fs.readFileSync(path.join(unmanaged, "user.txt"), "utf8"), "keep\n");

    const marker = JSON.parse(fs.readFileSync(path.join(installed, ".agentgear"), "utf8"));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.canonicalSkill, "handoff");
    assert.equal(marker.installedSkill, "acme-handoff");
    const state = readState(fixture);
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.skillPrefix, "acme");
    assert.equal(Object.hasOwn(state.targets[target], "skillPrefix"), false);
    assert.ok(state.targets[target].skills.handoff);
    assert.match(
      fs.readFileSync(path.join(installed, "agents", "openai.yaml"), "utf8"),
      /Use \$acme-handoff /
    );

    run([
      "install", "--skill", "handoff", "--target", "claude", "--no-launcher"
    ], fixture.environment);
    const inherited = path.join(inheritedTarget, "acme-handoff");
    const inheritedState = readState(fixture);
    assert.equal(inheritedState.schemaVersion, 3);
    assert.equal(inheritedState.skillPrefix, "acme");
    assert.equal(fs.existsSync(inherited), true);
    assert.equal(fs.existsSync(path.join(inheritedTarget, "handoff")), false);

    run(["update", "--skill", "handoff", "--target", "general", "--no-launcher"], fixture.environment);
    assert.equal(fs.existsSync(installed), true);
    assert.equal(fs.existsSync(path.join(target, "handoff", "user.txt")), true);
    assert.throws(
      () => run([
        "update", "--skill", "handoff", "--target", "claude", "--prefix", "other", "--no-launcher"
      ], fixture.environment),
      /Cannot change recorded skill prefix/
    );

    run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(installed), false);
    assert.equal(fs.existsSync(path.join(unmanaged, "user.txt")), true);
    const retainedState = readState(fixture);
    assert.equal(retainedState.schemaVersion, 3);
    assert.equal(retainedState.skillPrefix, "acme");
    assert.equal(retainedState.targets[inheritedTarget].skills.handoff.mode, "copy");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(inherited, ".agentgear"), "utf8")).schemaVersion,
      1
    );

    run(["uninstall", "--skill", "handoff", "--target", "claude"], fixture.environment);
    const downgradedState = readState(fixture);
    assert.equal(downgradedState.schemaVersion, 2);
    assert.equal(Object.hasOwn(downgradedState, "skillPrefix"), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("catalog changes revalidate the recorded prefix and run reports canonical-alias collisions", () => {
  const fixture = environmentFixture();
  try {
    run([
      "install", "--skill", "handoff", "--target", "general", "--prefix", "acme", "--no-launcher"
    ], fixture.environment);
    run([
      "install", "--skill", "handoff", "--target", "claude", "--no-launcher"
    ], fixture.environment);
    const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");
    const currentBefore = fs.realpathSync(path.join(fixture.dataRoot, "current"));
    const catalog = structuredClone(loadCatalog(rootDir));
    catalog.skills.skills["acme-handoff"] = structuredClone(catalog.skills.skills.handoff);

    assert.throws(
      () => installSelection({
        catalog,
        options: parseOptions([
          "--skill", "handoff", "--target", "claude", "--no-launcher"
        ]),
        sourceRoot: rootDir,
        env: fixture.environment
      }),
      /Invalid recorded skill prefix: .*conflicts with known skill "acme-handoff"/
    );
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);
    assert.equal(fs.realpathSync(path.join(fixture.dataRoot, "current")), currentBefore);
    assert.throws(
      () => resolveRunSkill(catalog, "acme-handoff", fixture.environment),
      /Ambiguous installed skill acme-handoff: acme-handoff, handoff/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("agentgear run accepts canonical and recorded prefixed skill names", () => {
  const fixture = environmentFixture();
  try {
    run([
      "install", "--skill", "multi-agent-protocol", "--target", "general", "--prefix", "acme", "--no-launcher"
    ], fixture.environment);
    for (const skill of ["multi-agent-protocol", "acme-multi-agent-protocol"]) {
      const result = spawnAgentgear(
        ["run", skill, "resolve-tool-command.js", "--help"],
        fixture,
        fixture.environment
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const unknown = spawnAgentgear(
      ["run", "other-multi-agent-protocol", "resolve-tool-command.js", "--help"],
      fixture,
      fixture.environment
    );
    assert.equal(unknown.status, 1);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("agentgear run supports command and skill help", () => {
  const fixture = environmentFixture();
  try {
    const commandHelp = spawnAgentgear(["run", "--help"], fixture, fixture.environment);
    assert.equal(commandHelp.status, 0, commandHelp.stderr);
    assert.match(commandHelp.stdout, /Usage: agentgear run <skill> <script> \[args\.\.\.\]/);
    assert.match(commandHelp.stdout, /Pass --help after <script> for script-specific help\./);

    for (const helpOption of ["--help", "-h"]) {
      const skillHelp = spawnAgentgear(
        ["run", "multi-agent-protocol", helpOption],
        fixture,
        fixture.environment
      );
      assert.equal(skillHelp.status, 0, skillHelp.stderr);
      assert.match(
        skillHelp.stdout,
        /Usage: agentgear run multi-agent-protocol <script> \[args\.\.\.\]/
      );
      assert.match(skillHelp.stdout, /Bundled scripts:/);
      assert.match(skillHelp.stdout, /  resolve-tool-command\.js/);
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("agentgear run skill help includes nested script paths", () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const nestedDirectory = path.join(
      checkout,
      "skills",
      "multi-agent-protocol",
      "scripts",
      "nested"
    );
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(path.join(nestedDirectory, "tool.mjs"), "");

    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(checkout, "bin", "agentgear.mjs"), "run", "multi-agent-protocol", "--help"],
      { cwd: checkout, encoding: "utf8", env: { ...process.env, ...fixture.environment } }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /  nested\/tool\.mjs/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("prefixed source installs link a rewritten discovery projection", t => {
  const fixture = environmentFixture();
  try {
    run([
      "source-install", "--skill", "handoff", "--target", "general", "--prefix", "acme", "--no-launcher"
    ], fixture.environment);
    const installed = path.join(fixture.home, ".agents", "skills", "acme-handoff");
    if (!fs.lstatSync(installed).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    assert.equal(
      fs.readlinkSync(installed),
      path.join(fixture.dataRoot, "current", "discovery-skills", "acme", "handoff")
    );
    const bootstrap = fs.readFileSync(path.join(installed, "SKILL.md"), "utf8");
    assert.match(bootstrap, /^name: acme-handoff$/m);
    assert.match(bootstrap, /agentgear skill get handoff/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("prefixed shared source installs withdraw omitted pack skills", t => {
  const fixture = environmentFixture();
  const catalog = structuredClone(loadCatalog(rootDir));
  catalog.skills.packs.small = {
    description: "Focused pack fixture.",
    skills: ["handoff"]
  };
  const install = argumentsList => installSelection({
    catalog,
    options: parseOptions(argumentsList),
    sourceRoot: rootDir,
    sourceInstall: true,
    env: fixture.environment
  });
  const target = path.join(fixture.home, ".agents", "skills");
  try {
    install(["--pack", "core", "--target", "general", "--prefix", "acme", "--no-launcher"]);
    const retained = path.join(target, "acme-handoff");
    if (!fs.lstatSync(retained).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    assert.equal(fs.existsSync(path.join(target, "acme-browse-web")), true);

    install(["--pack", "small", "--target", "general", "--no-launcher"]);
    assert.equal(fs.existsSync(retained), true);
    assert.equal(fs.existsSync(path.join(target, "acme-browse-web")), false);
    assert.deepEqual(Object.keys(readState(fixture).targets[target].skills), ["handoff"]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("prefixed projections reject symlinked mutable files without writing through them", () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const outsideSkill = path.join(fixture.temporary, "outside-SKILL.md");
  const original = "---\nname: handoff\ndescription: External diagnostic file.\n---\n\nKeep this unchanged.\n";
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.writeFileSync(outsideSkill, original);
    const skillFile = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.rmSync(skillFile);
    fs.symlinkSync(outsideSkill, skillFile, "file");

    assert.throws(
      () => installSelection({
        catalog: loadCatalog(checkout),
        options: parseOptions([
          "--skill", "handoff", "--target", "general", "--prefix", "acme", "--no-launcher"
        ]),
        sourceRoot: checkout,
        env: fixture.environment
      }),
      /Projected skill path is missing or unsafe/
    );
    assert.equal(fs.readFileSync(outsideSkill, "utf8"), original);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "acme-handoff")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("focused release updates preserve link and copy provenance for one projection", () => {
  const fixture = environmentFixture();
  const target = path.join(fixture.home, ".agents", "skills");
  const selectedTarget = path.join(fixture.home, ".claude", "skills");
  const current = path.join(fixture.dataRoot, "current");
  const skill = "handoff";
  const destination = path.join(target, skill);
  const selectedDestination = path.join(selectedTarget, skill);
  const source = path.join(current, "skills", skill);
  try {
    run([
      "install", "--skill", skill, "--target", "claude", "--no-launcher"
    ], fixture.environment);
    assert.equal(fs.existsSync(path.join(source, ".agentgear")), false);

    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(source, destination, "dir");
    const state = readState(fixture);
    state.targets[target] = { skills: { [skill]: { mode: "link", source } } };
    craftState(fixture, state);

    run([
      "update", "--skill", skill, "--target", "claude", "--no-launcher"
    ], fixture.environment);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, ".agentgear"), "utf8")), {
      schemaVersion: 0,
      skill,
      mode: "link",
      source
    });
    const updatedState = readState(fixture);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(selectedDestination, ".agentgear"), "utf8")), {
      schemaVersion: 0,
      skill,
      mode: "copy",
      source: updatedState.targets[selectedTarget].skills[skill].fingerprint
    });

    run(["uninstall", "--skill", skill, "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(readState(fixture).targets[target], undefined);
    assert.equal(fs.existsSync(selectedDestination), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("prefixed installs accept quoted canonical frontmatter names", () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const skillFile = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.writeFileSync(
      skillFile,
      fs.readFileSync(skillFile, "utf8").replace("name: handoff", "name: \"handoff\"")
    );

    installSelection({
      catalog: loadCatalog(checkout),
      options: parseOptions([
        "--skill", "handoff", "--target", "general", "--prefix", "acme", "--no-launcher"
      ]),
      sourceRoot: checkout,
      env: fixture.environment
    });
    assert.match(
      fs.readFileSync(path.join(fixture.home, ".agents", "skills", "acme-handoff", "SKILL.md"), "utf8"),
      /^name: acme-handoff$/m
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("default installation reaches every default target with the approved entry surface", () => {
  const fixture = environmentFixture();
  try {
    run(["install"], fixture.environment);
    for (const skillsRoot of [
      path.join(fixture.home, ".agents", "skills"),
      path.join(fixture.home, ".gemini", "skills"),
      path.join(fixture.home, ".gemini", "config", "skills"),
      path.join(fixture.home, ".claude", "skills")
    ]) {
      assert.equal(fs.existsSync(path.join(skillsRoot, "handoff", "SKILL.md")), true);
      assert.equal(fs.existsSync(path.join(skillsRoot, "tech-design-workflow", "SKILL.md")), true);
      assert.equal(fs.existsSync(path.join(skillsRoot, "multi-agent-protocol", "SKILL.md")), false);
    }
    assert.equal(
      fs.existsSync(path.join(fixture.home, ".gemini", "config", "skills.json")),
      false
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("legacy Agy target metadata migrates instead of invalidating installation state", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const geminiRoot = path.join(fixture.home, ".gemini", "skills");
    const configPath = path.join(fixture.home, ".gemini", "config", "skills.json");
    const state = readState(fixture);
    state.targets[geminiRoot].agyDiscovery = {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: ["handoff"]
    };
    craftState(fixture, state);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      entries: [{ path: "~/.gemini/skills", include_only: ["^handoff$"] }]
    }, null, 2)}\n`);

    const result = spawnAgentgearSourceInstall(
      ["--skill", "handoff", "--target", "gemini"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Migrated legacy Agy discovery state/);
    assert.equal(fs.existsSync(configPath), false);
    const migrated = readState(fixture).targets[geminiRoot];
    assert.equal(migrated.agyDiscovery, undefined);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("user-modified legacy Agy config is preserved without blocking installation", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const geminiRoot = path.join(fixture.home, ".gemini", "skills");
    const configPath = path.join(fixture.home, ".gemini", "config", "skills.json");
    const state = readState(fixture);
    state.targets[geminiRoot].agyDiscovery = {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: ["handoff"]
    };
    craftState(fixture, state);
    const changedConfig = {
      entries: [{
        path: "~/.gemini/skills",
        include_only: ["user-change"]
      }]
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(changedConfig, null, 2)}\n`);

    const result = spawnAgentgearSourceInstall(
      ["--skill", "handoff", "--target", "gemini"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migration will retry/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), changedConfig);
    assert.deepEqual(readState(fixture).targets[geminiRoot].agyDiscovery, {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: ["handoff"]
    });
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("user-modified legacy Agy config does not block uninstall", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const geminiRoot = path.join(fixture.home, ".gemini", "skills");
    const configPath = path.join(fixture.home, ".gemini", "config", "skills.json");
    const state = readState(fixture);
    state.targets[geminiRoot].agyDiscovery = {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: []
    };
    craftState(fixture, state);
    const changedConfig = {
      entries: [{
        path: "~/.gemini/skills",
        include_only: ["user-change"]
      }]
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(changedConfig, null, 2)}\n`);

    const result = spawnAgentgear(
      ["uninstall", "--skill", "handoff", "--target", "gemini"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /retired stale ownership after managed skills changed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), changedConfig);
    assert.equal(readState(fixture).targets[geminiRoot], undefined);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("unreadable legacy Agy config is preserved without blocking installation", () => {
  const fixture = environmentFixture();
  const originalReadFile = fs.readFileSync;
  try {
    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const geminiRoot = path.join(fixture.home, ".gemini", "skills");
    const configPath = path.join(fixture.home, ".gemini", "config", "skills.json");
    const state = readState(fixture);
    state.targets[geminiRoot].agyDiscovery = {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: ["handoff"]
    };
    craftState(fixture, state);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      entries: [{ path: "~/.gemini/skills", include_only: ["^handoff$"] }]
    }, null, 2)}\n`);
    fs.readFileSync = (filePath, ...argumentsList) => {
      if (path.resolve(String(filePath)) === configPath) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalReadFile(filePath, ...argumentsList);
    };

    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);

    fs.readFileSync = originalReadFile;
    assert.equal(fs.existsSync(configPath), true);
    assert.equal(Boolean(readState(fixture).targets[geminiRoot].agyDiscovery), true);
  } finally {
    fs.readFileSync = originalReadFile;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("legacy Agy target identity folds Windows path casing", () => {
  const context = { home: "C:\\Users\\Example", platform: "win32" };
  assert.equal(
    legacyAgyPathIdentity("c:\\users\\example\\.GEMINI\\SKILLS", context),
    legacyAgyPathIdentity("C:\\Users\\Example\\.gemini\\skills", context)
  );
  assert.deepEqual(validateLegacyAgyDiscovery({
    targetPath: "c:\\users\\example\\.GEMINI\\SKILLS",
    targetRecord: {
      skills: { handoff: {} },
      agyDiscovery: {
        schemaVersion: 1,
        entryCreated: true,
        fileCreated: true,
        baselineIncludeOnly: null,
        claims: ["handoff"]
      }
    },
    env: { HOME: "C:\\Users\\Example" },
    platform: "win32"
  }), { valid: true });
});

test("legacy Agy compatibility accepts only the exact historical ownership shape", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const geminiRoot = path.join(fixture.home, ".gemini", "skills");
    const state = readState(fixture);
    state.targets[geminiRoot].agyDiscovery = {
      schemaVersion: 1,
      entryCreated: true,
      fileCreated: true,
      baselineIncludeOnly: null,
      claims: ["handoff"],
      unexpected: true
    };
    craftState(fixture, state);

    const result = spawnAgentgearSourceInstall(
      ["--skill", "handoff", "--target", "gemini"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid legacy Agy discovery ownership/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("an explicit skill does not add the default all pack", () => {
  const catalog = loadCatalog(rootDir);
  const selection = selected(catalog, parseOptions(["--skill", "handoff"]));
  assert.deepEqual(selection.packs, []);
  assert.deepEqual(selection.skills, ["handoff"]);
});

test("transactional file transform preserves a concurrently created destination", () => {
  const fixture = environmentFixture();
  try {
    const filePath = path.join(fixture.temporary, "shared.json");
    fs.writeFileSync(filePath, "original\n");
    const transaction = createInstallTransaction();

    assert.throws(
      () => transaction.transformFile(filePath, () => {
        fs.writeFileSync(filePath, "concurrent\n", { flag: "wx" });
        return { contents: "agentgear\n" };
      }),
      /preserved concurrently changed .*original retained at/
    );

    assert.equal(fs.readFileSync(filePath, "utf8"), "concurrent\n");
    const backup = fs.readdirSync(fixture.temporary)
      .find(name => name.includes("shared.json.agentgear-backup"));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(fixture.temporary, backup), "utf8"), "original\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("optional transactional file transform reports a restored failure", () => {
  const fixture = environmentFixture();
  try {
    const filePath = path.join(fixture.temporary, "optional.json");
    fs.writeFileSync(filePath, "original\n");
    const transaction = createInstallTransaction();

    const result = transaction.tryTransformFile(filePath, () => {
      throw new Error("optional migration failed");
    });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /optional migration failed/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "original\n");
    transaction.commit();
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("transactional removal preserves a concurrently recreated destination on rollback", () => {
  const fixture = environmentFixture();
  try {
    const destination = path.join(fixture.temporary, "managed-skill");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "original.txt"), "original\n");
    const transaction = createInstallTransaction();
    transaction.remove([destination]);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "concurrent.txt"), "concurrent\n");

    assert.throws(
      () => transaction.rollback(),
      /preserved concurrently created .*original retained at/
    );
    assert.equal(fs.readFileSync(path.join(destination, "concurrent.txt"), "utf8"), "concurrent\n");
    const backup = fs.readdirSync(fixture.temporary)
      .find(name => name.includes("managed-skill.agentgear-backup"));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(fixture.temporary, backup, "original.txt"), "utf8"), "original\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("custom-destination install does not retire a skill in another target", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "gemini"], fixture.environment);
    const catalog = structuredClone(loadCatalog(rootDir));
    delete catalog.skills.skills.handoff;
    catalog.skills.retiredSkills = [...new Set([
      ...(catalog.skills.retiredSkills ?? []),
      "handoff"
    ])];
    const customRoot = path.join(fixture.temporary, "custom-skills");

    installSelection({
      catalog,
      options: parseOptions([
        "--skill", "explain-for-me", "--target", "general", "--dest", customRoot
      ]),
      sourceRoot: rootDir,
      env: fixture.environment
    });

    const geminiSkill = path.join(fixture.home, ".gemini", "skills", "handoff", "SKILL.md");
    assert.equal(fs.existsSync(geminiSkill), true);
    assert.equal(Boolean(readState(fixture).targets[path.dirname(path.dirname(geminiSkill))].skills.handoff), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("agentgear-source-install help states every option default", () => {
  const fixture = environmentFixture();
  try {
    const result = spawnAgentgearSourceInstall(["--help"], fixture, fixture.environment);
    assert.equal(result.status, 0, result.stderr);
    for (const expectation of [
      /--pack NAME\s+Install one or more packs \(default: all\)/,
      /--skill NAME\s+Install named skills when --pack is omitted \(default: none\)/,
      /--target NAME\[,NAME\]\s+Select destinations \(default: general,gemini,agy,claude\)/,
      /--scope global\|project\s+Use global or project destinations \(default: global\)/,
      /--project DIR\s+Project root for --scope project \(default: current directory\)/,
      /--dest DIR\s+Override one destination directory \(default: none; defaults to general\)/,
      /--prefix PREFIX\s+Prefix installed discovery skill names \(default: recorded or none\)/,
      /--force\s+Replace selected conflicting artifacts \(default: false\)/,
      /--no-launcher\s+Skip the global agentgear command \(default: false\)/,
      /-h, --help\s+Show this help \(default: false\)/,
      /Available packs:/,
      /core\s+Standalone skills with no multi-agent workflow dependency/,
      /workflow\s+Multi-agent workflow skills using Waypost and one supported session host/,
      /browser\s+Browser-validation skills for the multi-agent workflow/,
      /all\s+Every maintained capability in this repository/
    ]) {
      assert.match(result.stdout, expectation);
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("resolve-tool-command is available as a top-level Agentgear command", () => {
  const fixture = environmentFixture();
  try {
    const resolved = spawnAgentgear(
      ["resolve-tool-command", "--help"],
      fixture,
      fixture.environment
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /Usage: resolve-tool-command\.js \[options\]/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("permissions is available through the Agentgear CLI with user scope by default", () => {
  const fixture = environmentFixture();
  try {
    const result = spawnAgentgear(["permissions", "--help"], fixture, fixture.environment);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agentgear permissions init/);
    assert.match(result.stdout, /agentgear permissions check/);
    assert.match(result.stdout, /agentgear permissions preset list\|show\|add/);
    assert.match(result.stdout, /--scope user/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("session delete maps Agent Deck to its remove command", () => {
  const fixture = environmentFixture();
  const bin = path.join(fixture.temporary, "bin");
  const capture = path.join(fixture.temporary, "agent-deck-args.json");
  try {
    writeNodeExecutable(bin, "agent-deck", `
const fs = require("node:fs");
fs.writeFileSync(process.env.AGENTGEAR_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write("removed\\n");
`);
    const result = spawnAgentgear([
      "session", "delete", "--host", "agent-deck", "--session-id", "coder-1", "--profile", "personal", "--json"
    ], fixture, { ...fixture.environment, PATH: bin, AGENTGEAR_TEST_CAPTURE: capture });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "deleted");
    assert.equal(payload.delete_mode, "remove");
    assert.equal(payload.recoverable, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["-p", "personal", "remove", "coder-1"]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("session delete maps Thurbox to recoverable soft-delete without force", () => {
  const fixture = environmentFixture();
  const bin = path.join(fixture.temporary, "bin");
  const capture = path.join(fixture.temporary, "thurbox-args.json");
  try {
    writeNodeExecutable(bin, "thurbox-cli", `
const fs = require("node:fs");
fs.writeFileSync(process.env.AGENTGEAR_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ status: "deleted" }));
`);
    const result = spawnAgentgear([
      "session", "delete", "--host", "thurbox", "--session-id", "thurbox-1", "--json"
    ], fixture, { ...fixture.environment, PATH: bin, AGENTGEAR_TEST_CAPTURE: capture });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "deleted");
    assert.equal(payload.delete_mode, "soft-delete");
    assert.equal(payload.recoverable, true);
    const args = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(args, ["session", "delete", "thurbox-1", "--json"]);
    assert.equal(args.includes("--force"), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("session delete returns provider failure details in one stable schema", () => {
  const fixture = environmentFixture();
  const bin = path.join(fixture.temporary, "bin");
  try {
    writeNodeExecutable(bin, "thurbox-cli", `
process.stderr.write("database is locked\\n");
process.exit(7);
`);
    const result = spawnAgentgear([
      "session", "delete", "--host", "thurbox", "--session-id", "thurbox-1", "--json"
    ], fixture, { ...fixture.environment, PATH: bin });
    assert.equal(result.status, 3, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.error.exit_code, 7);
    assert.equal(payload.error.message, "database is locked");
    assert.equal(payload.provider_stderr, "database is locked\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("session delete launches Windows command shims through ComSpec", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-windows-provider-test-"));
  const shim = path.join(temporary, "agent-deck.CMD");
  fs.writeFileSync(shim, "@echo off\r\n");
  const calls = [];
  try {
    const payload = deleteSession({ host: "agent-deck", sessionId: "coder-1", profile: "", json: true }, {
      platform: "win32",
      env: { PATH: temporary, PATHEXT: ".CMD", ComSpec: "test-cmd.exe" },
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: "removed\n", stderr: "" };
      }
    });
    assert.equal(payload.status, "deleted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "test-cmd.exe");
    assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(calls[0].args[3], /agent-deck\.CMD remove coder-1$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("session delete rejects percent expansion through Windows command shims", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-windows-percent-test-"));
  const shim = path.join(temporary, "agent-deck.CMD");
  fs.writeFileSync(shim, "@echo off\r\n");
  let called = false;
  try {
    const payload = deleteSession({ host: "agent-deck", sessionId: "%PATH%", profile: "", json: true }, {
      platform: "win32",
      env: { PATH: temporary, PATHEXT: ".CMD", ComSpec: "test-cmd.exe" },
      spawnSync() {
        called = true;
        return { status: 0, stdout: "removed\n", stderr: "" };
      }
    });
    assert.equal(called, false);
    assert.equal(payload.status, "failed");
    assert.equal(payload.error.code, "EINVAL");
    assert.match(payload.error.message, /percent-containing provider value/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow doctor keeps optional Agent Deck documentation non-blocking across local states", () => {
  const fixture = environmentFixture();
  try {
    const bin = path.join(fixture.temporary, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["git", "node", "thurbox-cli"]) writeExecutable(bin, command);
    writeWaypostExecutable(bin);
    const environment = { ...fixture.environment, PATH: bin };

    const thurboxReady = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(thurboxReady.status, 0, thurboxReady.stderr);
    assert.match(thurboxReady.stdout, /ok\s+session host thurbox \(thurbox-cli\)/);
    assert.match(thurboxReady.stdout, /Supported session host: thurbox\./);

    fs.rmSync(path.join(bin, "thurbox-cli"));
    writeExecutable(bin, "agent-deck");
    const agentDeckReady = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(agentDeckReady.status, 0, agentDeckReady.stderr);
    assert.match(agentDeckReady.stdout, /available\s+optional documentation agent-deck \(run: agentgear skill get agent-deck\)/);
    assert.match(agentDeckReady.stdout, /Supported session host: agent-deck\./);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "retrieved-skills")), false, "doctor must not fetch documentation");

    const catalog = structuredClone(loadCatalog(rootDir));
    const sourceTree = path.join(fixture.temporary, "agent-deck-docs");
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const source = catalog.skills.upstreams["agent-deck"];
    source.contentDigest = upstreamSkillDigest(sourceTree);
    const digest = source.contentDigest.slice("sha256-v1:".length);
    const retrieved = path.join(fixture.dataRoot, "retrieved-skills", "agent-deck", digest);
    fs.mkdirSync(path.join(retrieved, "payload"), { recursive: true });
    fs.copyFileSync(path.join(sourceTree, "SKILL.md"), path.join(retrieved, "payload", "SKILL.md"));
    fs.writeFileSync(path.join(retrieved, ".agentgear-retrieved-skill.json"), `${JSON.stringify({
      schemaVersion: 1,
      name: "agent-deck",
      repository: source.repository,
      ref: source.ref,
      commit: source.commit,
      contentDigest: source.contentDigest,
      payload: "payload/SKILL.md"
    })}\n`);
    const catalogFile = path.join(rootDir, "catalog", "skills.json");
    const originalCatalog = fs.readFileSync(catalogFile, "utf8");
    try {
      fs.writeFileSync(catalogFile, `${JSON.stringify(catalog.skills, null, 2)}\n`);
      const retrievedReady = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
      assert.equal(retrievedReady.status, 0, retrievedReady.stderr);
      assert.match(retrievedReady.stdout, /verified local resource/);
      assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck", "SKILL.md")), false);
      fs.writeFileSync(path.join(retrieved, "payload", "SKILL.md"), "corrupt\n");
      const corruptReady = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
      assert.equal(corruptReady.status, 0, corruptReady.stderr);
      assert.match(corruptReady.stdout, /unverifiable local resource/);
    } finally {
      fs.writeFileSync(catalogFile, originalCatalog);
    }

    fs.rmSync(path.join(bin, "agent-deck"));
    const noHost = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(noHost.status, 1);
    assert.match(noHost.stdout, /Missing one supported session host: agent-deck or thurbox\./);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow doctor requires Waypost 0.6.0 from --version output", () => {
  const fixture = environmentFixture();
  try {
    const bin = path.join(fixture.temporary, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["git", "node", "thurbox-cli"]) writeExecutable(bin, command);
    const environment = { ...fixture.environment, PATH: bin };

    writeWaypostExecutable(bin, "waypost 0.5.9");
    const old = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(old.status, 1);
    assert.match(old.stdout, /incompatible waypost \(required >= 0\.6\.0; found 0\.5\.9; version too old\)/);

    writeWaypostExecutable(bin, "unknown");
    const invalid = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /invalid --version output/);

    writeWaypostExecutable(bin, "unused", 2);
    const unsupported = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stdout, /--version failed/);

    writeWaypostExecutable(bin, "waypost version 0.7.0");
    const current = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /ok\s+waypost 0\.7\.0 \(required >= 0\.6\.0\)/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow doctor recognizes verified immutable Agent Deck documentation without retrieval or target mutation", () => {
  const fixture = environmentFixture();
  try {
    const bin = path.join(fixture.temporary, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["git", "node", "agent-deck"]) writeExecutable(bin, command);
    writeWaypostExecutable(bin);
    const environment = { ...fixture.environment, PATH: bin };
    const runtime = path.join(fixture.dataRoot, "current");
    const sourceTree = path.join(runtime, "skills", "agent-deck");
    fs.mkdirSync(path.join(runtime, "catalog"), { recursive: true });
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const catalog = structuredClone(loadCatalog(rootDir));
    catalog.skills.upstreams["agent-deck"].contentDigest = upstreamSkillDigest(sourceTree);
    fs.writeFileSync(path.join(runtime, "catalog", "skills.json"), `${JSON.stringify({ upstreams: catalog.skills.upstreams })}\n`);
    const catalogFile = path.join(rootDir, "catalog", "skills.json");
    const originalCatalog = fs.readFileSync(catalogFile, "utf8");
    try {
      fs.writeFileSync(catalogFile, `${JSON.stringify(catalog.skills, null, 2)}\n`);
      const result = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /verified local resource/);
      assert.equal(fs.existsSync(path.join(fixture.dataRoot, "retrieved-skills")), false);
      assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck", "SKILL.md")), false);
    } finally {
      fs.writeFileSync(catalogFile, originalCatalog);
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("unprefixed release installs retain schema-v2 and marker-v0 rollback readability", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--pack", "core", "--target", "general"], fixture.environment);
    const skill = path.join(fixture.home, ".agents", "skills", "handoff");
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(skill, "SKILL.md")), true);
    assert.equal(fs.existsSync(fixture.dataRoot), true);

    const state = readState(fixture);
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.channel, "release");
    assert.equal(state.releases.length, 1);
    assert.match(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.fingerprint, /^sha256-v1:[0-9a-f]{64}$/);
    assert.equal(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.mode, "copy");
    assert.equal(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.source, undefined);
    assert.equal(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.runtimeId, undefined);
    assert.equal(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.installedAt, undefined);
    assert.equal(
      Object.hasOwn(state, "skillPrefix"),
      false
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(skill, ".agentgear"), "utf8")), {
      schemaVersion: 0,
      skill: "handoff",
      mode: "copy",
      source: state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff.fingerprint
    });

    const launcher = path.join(fixture.localBin, "agentgear");
    if (fs.lstatSync(launcher).isSymbolicLink()) {
      assert.equal(
        fs.readlinkSync(launcher),
        path.join(fixture.dataRoot, "current", "bin", "agentgear.mjs")
      );
    }
    assert.deepEqual(state.commands[launcher], {
      kind: "launcher",
      mode: "link",
      target: path.join(fixture.dataRoot, "current", "bin", "agentgear.mjs")
    });
    const current = path.join(fixture.dataRoot, "current");
    assert.equal(fs.readlinkSync(current), path.join(fixture.releasesRoot, state.releases[0]));

    // An explicit skill is a focused selection, so this leaves the other
    // core records and the runtime intact.
    run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(skill), false);
    const afterUninstall = readState(fixture);
    assert.deepEqual(
      Object.keys(afterUninstall.targets[path.join(fixture.home, ".agents", "skills")].skills).sort(),
      ["assess-tech-design", "browse-web", "commit-staged", "explain-for-me", "explore-defects", "fix-strategy", "search-files"]
    );
    assert.equal(afterUninstall.channel, "release");
    assert.equal(afterUninstall.releases.length, 1);
    assert.equal(Object.keys(afterUninstall.commands).length, 1);
    assert.equal(pathExists(current), true);
    assert.equal(pathExists(launcher), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow installation exposes only its approved entries and provisions the Agentgear launcher", () => {
  const fixture = environmentFixture();
  try {
    const result = spawnAgentgear(
      ["install", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /permission_migration_required/);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "check-waypost-messages", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "route-waypost-action", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "delegate-code-task", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "multi-agent-protocol", "SKILL.md")), false);
    const state = readState(fixture);
    assert.deepEqual(Object.keys(state.commands), [path.join(fixture.localBin, "agentgear")]);
    assert.equal(pathExists(path.join(fixture.localBin, "adwf-send-and-wake")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("schema-v2 historical full-pack links reconcile install, update, and workflow/browser/all uninstall", async t => {
  if (process.platform === "win32") {
    t.skip("historical link records are POSIX-specific");
    return;
  }
  const historicalCases = [
    ["install workflow", "install", ["--pack", "workflow"]],
    ["update workflow", "update", ["--pack", "workflow"]],
    ["uninstall workflow", "uninstall", ["--pack", "workflow"]],
    ["uninstall browser", "uninstall", ["--pack", "browser"]],
    ["uninstall all", "uninstall", ["--pack", "all"]]
  ];
  for (const [name, operation, commandArguments] of historicalCases) {
    await t.test(name, () => {
      const fixture = environmentFixture();
      const payload = path.join(fixture.temporary, "pinned-agent-deck");
      const bin = path.join(fixture.temporary, "bin");
      const provisioned = [];
      try {
        fs.mkdirSync(payload, { recursive: true });
        fs.writeFileSync(path.join(payload, "SKILL.md"), "# Agent Deck fixture\n");
        fs.mkdirSync(bin, { recursive: true });
        writeExecutable(bin, "agent-deck");
        fixture.environment.PATH = bin;

        const catalog = structuredClone(loadCatalog(rootDir));
        const pinnedDigest = upstreamSkillDigest(payload);
        catalog.skills.upstreams["agent-deck"].contentDigest = pinnedDigest;
        const provisionUpstreamSkill = ({ plan, runtime }) => {
          assert.equal(plan.name, "agent-deck");
          assert.equal(plan.source.contentDigest, pinnedDigest);
          assert.equal(upstreamSkillDigest(payload), pinnedDigest);
          const destination = path.join(runtime.root, "skills", plan.name);
          fs.cpSync(payload, destination, { recursive: true });
          assert.equal(upstreamSkillDigest(destination), plan.source.contentDigest);
          provisioned.push(plan.name);
        };
        const install = argumentsList => installSelection({
          catalog,
          options: parseOptions(argumentsList),
          sourceRoot: rootDir,
          env: fixture.environment,
          provisionUpstreamSkill
        });

        install(["--pack", "workflow", "--target", "general"]);
        const target = path.join(fixture.home, ".agents", "skills");
        const current = path.join(fixture.dataRoot, "current");
        const state = readState(fixture);
        const legacySkills = ["multi-agent-protocol"];
        const historicalSkills = [...legacySkills, "agent-deck"];
        for (const skill of historicalSkills) {
          const destination = path.join(target, skill);
          const source = path.join(current, "skills", skill);
          fs.rmSync(destination, { recursive: true, force: true });
          if (skill === "agent-deck") {
            assert.equal(fs.lstatSync(source).isDirectory(), true);
            assert.equal(fs.existsSync(path.join(source, "SKILL.md")), true);
          }
          fs.symlinkSync(source, destination, "dir");
          state.targets[target].skills[skill] = {
            mode: "link",
            source
          };
        }
        state.schemaVersion = 2;
        delete state.skillPrefix;
        craftState(fixture, state);

        const before = readState(fixture);
        const agentDeckDestination = path.join(target, "agent-deck");
        const agentDeckSource = path.join(current, "skills", "agent-deck");
        assert.equal(fs.existsSync(agentDeckDestination), true);
        assert.equal(fs.realpathSync(agentDeckDestination), fs.realpathSync(agentDeckSource));
        assert.deepEqual(before.targets[target].skills["agent-deck"], {
          mode: "link",
          source: agentDeckSource
        });

        if (operation === "install" || operation === "update") {
          install([...commandArguments, "--target", "general"]);
          assert.equal(provisioned.length, 2, `${operation} must provision the verified pinned fixture`);
        } else {
          run([operation, ...commandArguments, "--target", "general"], fixture.environment);
        }

        const after = readState(fixture);
        assert.equal(after.schemaVersion, 2);
        assert.equal(Object.hasOwn(after, "skillPrefix"), false);
        for (const skill of historicalSkills) {
          assert.equal(fs.existsSync(path.join(target, skill)), false, `${operation} must withdraw ${skill}`);
          assert.equal(after.targets[target]?.skills[skill], undefined, `${operation} must remove ${skill} state`);
        }
        assert.equal(fs.existsSync(agentDeckDestination), false, `${operation} must not expose agent-deck`);
        assert.equal(after.targets[target]?.skills["agent-deck"], undefined, `${operation} must remove agent-deck state`);
        const keepsCurrentEntries = operation === "install" || operation === "update";
        assert.equal(fs.existsSync(path.join(target, "delegate-code-task")), keepsCurrentEntries);
        assert.equal(Boolean(after.targets[target]?.skills["delegate-code-task"]), keepsCurrentEntries);
      } finally {
        fs.rmSync(fixture.temporary, { recursive: true, force: true });
      }
    });
  }
});

test("workflow update removes the retired Agent Deck permission helper", t => {
  if (process.platform === "win32") {
    t.skip("legacy link migration fixture is POSIX-specific");
    return;
  }
  const fixture = environmentFixture();
  const legacyCommand = path.join(fixture.localBin, "agent-deck-workflow-init-permissions");
  const current = path.join(fixture.dataRoot, "current");
  const legacyTarget = path.join(current, "skills", "multi-agent-protocol", "scripts", "agent-deck-workflow-init-permissions.mjs");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    const physicalTarget = path.join(fs.realpathSync(current), "skills", "multi-agent-protocol", "scripts", "agent-deck-workflow-init-permissions.mjs");
    fs.writeFileSync(physicalTarget, "#!/usr/bin/env node\n");
    fs.symlinkSync(legacyTarget, legacyCommand);
    const state = readState(fixture);
    state.commands[legacyCommand] = { kind: "workflow-helper", mode: "link", target: legacyTarget };
    craftState(fixture, state);

    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(legacyCommand);
    fs.writeFileSync(legacyCommand, "user-owned replacement\n");
    assert.throws(
      () => run(["update", "--pack", "workflow", "--target", "general"], fixture.environment),
      /Refusing to retire locally changed command/
    );
    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(readState(fixture).commands[legacyCommand].target, legacyTarget);

    fs.rmSync(legacyCommand);
    fs.symlinkSync(legacyTarget, legacyCommand);

    run(["update", "--pack", "workflow", "--target", "general"], fixture.environment);

    assert.equal(pathExists(legacyCommand), false);
    assert.equal(readState(fixture).commands[legacyCommand], undefined);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow update with --no-launcher retires send-and-wake and requires permission migration", t => {
  if (process.platform === "win32") {
    t.skip("retired link migration fixture is POSIX-specific");
    return;
  }
  const fixture = environmentFixture();
  const retiredCommand = path.join(fixture.localBin, "adwf-send-and-wake");
  const launcher = path.join(fixture.localBin, "agentgear");
  const current = path.join(fixture.dataRoot, "current");
  const retiredTarget = path.join(current, "skills", "multi-agent-protocol", "scripts", "adwf-send-and-wake.mjs");
  const claudeSettings = path.join(fixture.home, ".claude", "settings.json");
  const codexRules = path.join(fixture.home, ".codex", "rules", "agentgear-workflow.rules");
  const geminiPolicy = path.join(fixture.home, ".gemini", "policies", "agentgear-workflow.toml");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    const physicalTarget = path.join(fs.realpathSync(current), "skills", "multi-agent-protocol", "scripts", "adwf-send-and-wake.mjs");
    fs.writeFileSync(physicalTarget, "#!/usr/bin/env node\n");
    fs.symlinkSync(retiredTarget, retiredCommand);
    const state = readState(fixture);
    state.commands[retiredCommand] = { kind: "workflow-helper", mode: "link", target: retiredTarget };
    craftState(fixture, state);
    const launcherTarget = fs.readlinkSync(launcher);

    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, `${JSON.stringify({
      permissions: { allow: ["Bash(~/.local/bin/adwf-send-and-wake *)"] }
    }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(codexRules), { recursive: true });
    fs.writeFileSync(codexRules, 'prefix_rule(\n    pattern = ["~/.local/bin/adwf-send-and-wake"],\n    decision = "allow",\n)\n');
    fs.mkdirSync(path.dirname(geminiPolicy), { recursive: true });
    fs.writeFileSync(geminiPolicy, '[[rule]]\ndecision = "allow"\ncommandPrefix = ["~/.local/bin/adwf-send-and-wake"]\n');

    const result = spawnAgentgear(
      ["update", "--no-launcher", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SECURITY ACTION REQUIRED: permission_migration_required command=adwf-send-and-wake/);
    assert.match(result.stdout, /Run: agentgear permissions init/);
    assert.match(result.stdout, /agentgear permissions init --scope project --project <path>/);
    assert.match(result.stdout, /Restart existing agent sessions/);
    assert.equal(pathExists(retiredCommand), false);
    assert.equal(readState(fixture).commands[retiredCommand], undefined);
    assert.equal(fs.readlinkSync(launcher), launcherTarget);
    // Arbitrary historical scopes cannot be discovered safely; the update must
    // require explicit migration instead of claiming these files were changed.
    assert.match(fs.readFileSync(claudeSettings, "utf8"), /adwf-send-and-wake/);
    assert.match(fs.readFileSync(codexRules, "utf8"), /adwf-send-and-wake/);
    assert.match(fs.readFileSync(geminiPolicy, "utf8"), /adwf-send-and-wake/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow update requires permission reinitialization for a missing design launcher grant", () => {
  const fixture = environmentFixture();
  const claudeSettings = path.join(fixture.home, ".claude", "settings.json");
  const project = path.join(fixture.temporary, "project");
  const projectCodexRules = path.join(project, ".codex", "rules", "agentgear-workflow.rules");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, `${JSON.stringify({
      permissions: { allow: ["Bash(agentgear run multi-agent-protocol *)"] }
    }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(projectCodexRules), { recursive: true });
    fs.writeFileSync(projectCodexRules, '# Agentgear workflow - generated approval rules\nprefix_rule(\n    pattern = ["agentgear", "run", "multi-agent-protocol"],\n)\n');

    const scopes = permissionMigrationScopes({ scope: "global", project }, fixture.environment);
    assert.deepEqual(scopes.map(result => result.scope), ["user", "project"]);

    const result = spawnAgentgear(
      ["update", "--pack", "workflow", "--target", "general", "--project", project],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SECURITY ACTION REQUIRED: permission_migration_required missing=workflow-launcher/);
    assert.match(result.stdout, /Detected outdated workflow launcher approvals in scope\(s\): user,project/);
    assert.match(result.stdout, /Run: agentgear permissions init/);
    assert.match(result.stdout, /Restart existing agent sessions/);
    assert.doesNotMatch(fs.readFileSync(claudeSettings, "utf8"), /tech-design-workflow/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow update requires permission reinitialization for missing Waypost CLI fail", () => {
  const fixture = environmentFixture();
  const claudeDir = path.join(fixture.home, ".claude");
  const command = "/opt/waypost";
  const stateDir = "/opt/waypost-state";
  const permission = `Bash(${command} --state-dir ${stateDir} read)`;
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), `${JSON.stringify({ permissions: { allow: [permission] } })}\n`);
    fs.writeFileSync(path.join(claudeDir, ".agentgear-workflow-permissions.json"), `${JSON.stringify({
      version: 3,
      permissions: [permission],
      mcp_permissions: [],
      rules: [{ command, state_dir: stateDir, action: "read", wildcard: false }]
    })}\n`);

    const result = spawnAgentgear(
      ["update", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /permission_migration_required missing=waypost-cli-fail/);
    assert.match(result.stdout, /Detected outdated Waypost CLI approvals in scope\(s\): user/);
    assert.match(result.stdout, /Run: agentgear permissions init/);
    assert.match(result.stdout, /Restart existing agent sessions/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow update requires permission reinitialization for retired session_resolve approval", () => {
  const fixture = environmentFixture();
  const claudeSettings = path.join(fixture.home, ".claude", "settings.json");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, `${JSON.stringify({
      permissions: { allow: ["mcp__waypost__session_resolve"] }
    })}\n`);

    const result = spawnAgentgear(
      ["update", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /permission_migration_required tool=session_resolve/);
    assert.match(result.stdout, /Detected retired permission approvals in scope\(s\): user/);
    assert.match(result.stdout, /Run: agentgear permissions init/);
    assert.doesNotMatch(result.stdout, /permission_migration_required command=adwf-send-and-wake/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow update reports every category in mixed retired Claude approvals", () => {
  const fixture = environmentFixture();
  const claudeSettings = path.join(fixture.home, ".claude", "settings.json");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, `${JSON.stringify({
      permissions: { allow: [
        "mcp__waypost__session_resolve",
        "Bash(~/.local/bin/adwf-send-and-wake *)"
      ] }
    })}\n`);

    const result = spawnAgentgear(
      ["update", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /permission_migration_required tool=session_resolve/);
    assert.match(result.stdout, /permission_migration_required command=adwf-send-and-wake/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("purge and later install report retired approvals after installation state is gone", t => {
  if (process.platform === "win32") {
    t.skip("retired link migration fixture is POSIX-specific");
    return;
  }
  const fixture = environmentFixture();
  const retiredCommand = path.join(fixture.localBin, "adwf-send-and-wake");
  const current = path.join(fixture.dataRoot, "current");
  const retiredTarget = path.join(current, "skills", "multi-agent-protocol", "scripts", "adwf-send-and-wake.mjs");
  const claudeSettings = path.join(fixture.home, ".claude", "settings.json");
  const codexRules = path.join(fixture.home, ".codex", "rules", "agentgear-workflow.rules");
  const geminiPolicy = path.join(fixture.home, ".gemini", "policies", "agentgear-workflow.toml");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    const physicalTarget = path.join(fs.realpathSync(current), "skills", "multi-agent-protocol", "scripts", "adwf-send-and-wake.mjs");
    fs.writeFileSync(physicalTarget, "#!/usr/bin/env node\n");
    fs.symlinkSync(retiredTarget, retiredCommand);
    const state = readState(fixture);
    state.commands[retiredCommand] = { kind: "workflow-helper", mode: "link", target: retiredTarget };
    craftState(fixture, state);

    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, `${JSON.stringify({
      permissions: { allow: ["Bash(~/.local/bin/adwf-send-and-wake *)"] }
    }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(codexRules), { recursive: true });
    fs.writeFileSync(codexRules, 'prefix_rule(\n    pattern = ["~/.local/bin/adwf-send-and-wake"],\n    decision = "allow",\n)\n');
    fs.mkdirSync(path.dirname(geminiPolicy), { recursive: true });
    fs.writeFileSync(geminiPolicy, '[[rule]]\ndecision = "allow"\ncommandPrefix = ["~/.local/bin/adwf-send-and-wake"]\n');

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.match(purge.stdout, /permission_migration_required command=adwf-send-and-wake/);
    assert.match(purge.stdout, /Detected retired permission approvals in scope\(s\): user/);
    assert.equal(pathExists(retiredCommand), false);
    assert.equal(pathExists(fixture.stateFile), false);

    const install = spawnAgentgear(
      ["install", "--pack", "workflow", "--target", "general"],
      fixture,
      fixture.environment
    );
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /permission_migration_required command=adwf-send-and-wake/);
    assert.match(install.stdout, /Detected retired permission approvals in scope\(s\): user/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source install transactionally retires obsolete linked skill names", t => {
  if (process.platform === "win32") {
    t.skip("legacy linked-skill migration fixture is POSIX-specific");
    return;
  }
  const fixture = environmentFixture();
  const targetRoot = path.join(fixture.home, ".agents", "skills");
  const oldSkill = "agent-deck-workflow";
  const oldDestination = path.join(targetRoot, oldSkill);
  const oldSource = path.join(fixture.dataRoot, "current", "skills", oldSkill);
  try {
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.symlinkSync(oldSource, oldDestination, "dir");
    const state = readState(fixture);
    state.targets[targetRoot].skills[oldSkill] = { mode: "link", source: oldSource };
    craftState(fixture, state);

    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);

    assert.equal(pathExists(oldDestination), false);
    assert.equal(readState(fixture).targets[targetRoot].skills[oldSkill], undefined);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("release update removes owned retired copies and preserves changed ones", () => {
  const fixture = environmentFixture();
  const generalRoot = path.join(fixture.home, ".agents", "skills");
  const claudeRoot = path.join(fixture.home, ".claude", "skills");
  const oldSkill = "tech-design-assessment";
  const ownedDestination = path.join(generalRoot, oldSkill);
  const changedDestination = path.join(claudeRoot, oldSkill);
  try {
    run(["install", "--skill", "handoff"], fixture.environment);
    for (const destination of [ownedDestination, changedDestination]) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "SKILL.md"), "# Retired\n");
    }
    const state = readState(fixture);
    state.targets[generalRoot].skills[oldSkill] = {
      mode: "copy",
      fingerprint: directoryFingerprint(ownedDestination)
    };
    state.targets[claudeRoot].skills[oldSkill] = {
      mode: "copy",
      fingerprint: directoryFingerprint(changedDestination)
    };
    craftState(fixture, state);
    fs.appendFileSync(path.join(changedDestination, "SKILL.md"), "locally changed\n");

    run(["update", "--skill", "handoff"], fixture.environment);

    const updated = readState(fixture);
    assert.equal(pathExists(ownedDestination), false);
    assert.equal(pathExists(changedDestination), true);
    assert.equal(updated.targets[generalRoot].skills[oldSkill], undefined);
    assert.equal(updated.targets[claudeRoot].skills[oldSkill], undefined);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow installation stages usable Agent Deck documentation without exposing it", () => {
  const fixture = environmentFixture();
  const bin = path.join(fixture.temporary, "bin");
  const installed = [];
  const messages = [];
  try {
    fs.mkdirSync(bin, { recursive: true });
    writeExecutable(bin, "agent-deck");
    fixture.environment.PATH = bin;
    const catalog = loadCatalog(rootDir);
    const options = parseOptions(["--pack", "workflow", "--target", "general"]);
    installSelection({
      catalog,
      options,
      sourceRoot: rootDir,
      env: fixture.environment,
      print: message => messages.push(message),
      provisionUpstreamSkill: ({ plan, runtime }) => {
        installed.push(plan);
        const skillDir = path.join(runtime.root, "skills", plan.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Agent Deck\n");
      }
    });

    assert.deepEqual(installed.map(plan => plan.name), ["agent-deck"]);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "current", "skills", "agent-deck", "SKILL.md")), true);
    const skill = path.join(fixture.home, ".agents", "skills", "agent-deck", "SKILL.md");
    assert.equal(fs.existsSync(skill), false);
    assert.equal(readState(fixture).targets[path.join(fixture.home, ".agents", "skills")].skills["agent-deck"], undefined);
    for (const message of [
      "Checking installation state...",
      "Staging runtime snapshot...",
      "Checking deployment mode...",
      "Validating staged runtime...",
      "Saving installation state..."
    ]) {
      assert.equal(messages.includes(message), true, `missing progress message: ${message}`);
    }
    assert.equal(
      messages.some(message => /^Installing \d+ skill\(s\) to general\.\.\.$/.test(message)),
      true,
      "missing skill installation progress message"
    );

    run(["uninstall", "--pack", "workflow", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(skill), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("Agent Deck retrieval materializes verified content without target exposure and reuses it offline", () => {
  const fixture = environmentFixture();
  const sourceTree = path.join(fixture.temporary, "agent-deck-source");
  try {
    fs.mkdirSync(path.join(sourceTree, "references"), { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\nRead `references/guide.md`.\n");
    fs.writeFileSync(path.join(sourceTree, "references", "guide.md"), "# Guide\n");
    const catalog = structuredClone(loadCatalog(rootDir));
    const source = catalog.skills.upstreams["agent-deck"];
    source.contentDigest = upstreamSkillDigest(sourceTree);
    const plan = { upstream: "agent-deck", name: "agent-deck", source };
    let provisions = 0;
    const provision = ({ runtime }) => {
      provisions += 1;
      fs.mkdirSync(path.join(runtime.root, "skills"), { recursive: true });
      fs.cpSync(sourceTree, path.join(runtime.root, "skills", "agent-deck"), { recursive: true });
    };

    const first = retrieveUpstreamSkill({
      catalog,
      skill: "agent-deck",
      env: fixture.environment,
      runtimeRoots: [],
      provision
    });
    const materialized = retrievedSkillMaterializationRoot(path.join(fixture.environment.XDG_DATA_HOME, "agentgear"), plan);
    assert.equal(provisions, 1);
    assert.equal(first.materialized, true);
    assert.equal(first.payload, path.join(materialized, "payload"));
    assert.equal(fs.readFileSync(path.join(first.payload, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck")), false);
    assert.equal(fs.existsSync(fixture.stateFile), false);

    const second = retrieveUpstreamSkill({
      catalog,
      skill: "agent-deck",
      env: fixture.environment,
      runtimeRoots: [],
      provision: () => {
        throw new Error("offline fetch must not run");
      }
    });
    assert.equal(second.materialized, false);
    assert.equal(second.payload, first.payload);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("Agent Deck retrieval reuses a verified immutable runtime copy and rejects corrupt materialization", () => {
  const fixture = environmentFixture();
  const runtime = path.join(fixture.temporary, "runtime");
  const sourceTree = path.join(runtime, "skills", "agent-deck");
  try {
    fs.mkdirSync(path.join(runtime, "catalog"), { recursive: true });
    fs.mkdirSync(path.join(sourceTree, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    fs.writeFileSync(path.join(sourceTree, "assets", "example.txt"), "resource\n");
    const catalog = structuredClone(loadCatalog(rootDir));
    const source = catalog.skills.upstreams["agent-deck"];
    source.contentDigest = upstreamSkillDigest(sourceTree);
    fs.writeFileSync(path.join(runtime, "catalog", "skills.json"), `${JSON.stringify({ upstreams: { "agent-deck": source } })}\n`);
    const plan = { upstream: "agent-deck", name: "agent-deck", source };
    const retrieved = retrieveUpstreamSkill({
      catalog,
      skill: "agent-deck",
      env: fixture.environment,
      runtimeRoots: [runtime],
      provision: () => {
        throw new Error("verified runtime copy should win");
      }
    });
    assert.equal(fs.readFileSync(path.join(retrieved.payload, "assets", "example.txt"), "utf8"), "resource\n");
    const root = retrievedSkillMaterializationRoot(path.join(fixture.environment.XDG_DATA_HOME, "agentgear"), plan);
    fs.appendFileSync(path.join(root, "payload", "SKILL.md"), "changed\n");
    assert.throws(
      () => retrieveUpstreamSkill({ catalog, skill: "agent-deck", env: fixture.environment, runtimeRoots: [runtime] }),
      /Retrieved upstream skill is unverifiable/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("upstream provisioning uses a filtered sparse fetch instead of cloning the repository", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-upstream-fetch-test-"));
  const runtime = { root: path.join(temporary, "runtime") };
  const expected = path.join(temporary, "expected");
  const commands = [];
  const messages = [];
  const source = {
    repository: "https://example.invalid/agent-deck.git",
    skillPath: "skills/agent-deck",
    ref: "v1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    contentDigest: ""
  };
  const plan = { upstream: "agent-deck", name: "agent-deck", source };
  try {
    fs.mkdirSync(path.join(runtime.root, "skills"), { recursive: true });
    fs.mkdirSync(expected, { recursive: true });
    fs.writeFileSync(path.join(expected, "SKILL.md"), "# Agent Deck\n");
    source.contentDigest = upstreamSkillDigest(expected);

    provisionPinnedUpstreamSkill({
      plan,
      runtime,
      previousRuntimeRoots: [],
      print: message => messages.push(message),
      runGitCommand: (argumentsList, _env, options = {}) => {
        commands.push({ argumentsList, options });
        if (argumentsList.includes("rev-parse")) return source.commit;
        if (argumentsList.includes("reset")) {
          const checkout = argumentsList[1];
          const skill = path.join(checkout, "skills", "agent-deck");
          fs.mkdirSync(skill, { recursive: true });
          fs.writeFileSync(path.join(skill, "SKILL.md"), "# Agent Deck\n");
        }
        return "";
      }
    });

    assert.equal(commands.some(command => command.argumentsList.includes("clone")), false);
    const fetch = commands.find(command => command.argumentsList.includes("fetch"));
    assert.ok(fetch);
    assert.equal(fetch.argumentsList.includes("--filter=blob:none"), true);
    assert.equal(fetch.argumentsList.includes("--depth"), true);
    assert.equal(fetch.argumentsList.includes("--progress"), true);
    assert.equal(fetch.options.streamProgress, true);
    assert.equal(
      commands.some(command => command.argumentsList.join("\0").includes("sparse-checkout\0set\0skills/agent-deck")),
      true
    );
    assert.equal(
      fs.readFileSync(path.join(runtime.root, "skills", "agent-deck", "SKILL.md"), "utf8"),
      "# Agent Deck\n"
    );
    assert.deepEqual(messages, [
      "Upstream skill agent-deck: checking verified cache...",
      "Upstream skill agent-deck: fetching v1.0.0 with a filtered, shallow Git fetch...",
      "Upstream skill agent-deck: materializing skills/agent-deck only...",
      "Upstream skill agent-deck: verifying pinned content...",
      "Upstream skill agent-deck: ready."
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("upstream provisioning reuses the current runtime when the pin is unchanged", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-upstream-reuse-test-"));
  const previousRuntimeRoot = path.join(temporary, "previous");
  const runtime = { root: path.join(temporary, "next") };
  const source = {
    repository: "https://example.invalid/agent-deck.git",
    skillPath: "skills/agent-deck",
    ref: "v1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    contentDigest: ""
  };
  const plan = { upstream: "agent-deck", name: "agent-deck", source };
  const messages = [];
  try {
    fs.mkdirSync(path.join(previousRuntimeRoot, "catalog"), { recursive: true });
    fs.mkdirSync(path.join(previousRuntimeRoot, "skills", "agent-deck"), { recursive: true });
    fs.mkdirSync(path.join(runtime.root, "skills"), { recursive: true });
    const cachedSkill = path.join(previousRuntimeRoot, "skills", "agent-deck");
    fs.writeFileSync(path.join(cachedSkill, "SKILL.md"), "# Agent Deck\n");
    source.contentDigest = upstreamSkillDigest(cachedSkill);
    fs.writeFileSync(
      path.join(previousRuntimeRoot, "catalog", "skills.json"),
      `${JSON.stringify({ upstreams: { "agent-deck": source } })}\n`
    );

    provisionPinnedUpstreamSkill({
      plan,
      runtime,
      previousRuntimeRoots: [previousRuntimeRoot],
      env: { PATH: "" },
      print: message => messages.push(message)
    });

    assert.equal(
      fs.readFileSync(path.join(runtime.root, "skills", "agent-deck", "SKILL.md"), "utf8"),
      "# Agent Deck\n"
    );
    assert.deepEqual(messages, [
      "Upstream skill agent-deck: checking verified cache...",
      "Upstream skill agent-deck: reused cached copy."
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("upstream provisioning rejects modified cached content", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-upstream-integrity-test-"));
  const previousRuntimeRoot = path.join(temporary, "previous");
  const runtime = { root: path.join(temporary, "next") };
  const cachedSkill = path.join(previousRuntimeRoot, "skills", "agent-deck");
  const source = {
    repository: "https://example.invalid/agent-deck.git",
    skillPath: "skills/agent-deck",
    ref: "v1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    contentDigest: ""
  };
  const plan = { upstream: "agent-deck", name: "agent-deck", source };
  try {
    fs.mkdirSync(path.join(previousRuntimeRoot, "catalog"), { recursive: true });
    fs.mkdirSync(cachedSkill, { recursive: true });
    fs.mkdirSync(path.join(runtime.root, "skills"), { recursive: true });
    fs.writeFileSync(path.join(cachedSkill, "SKILL.md"), "# Agent Deck\n");
    source.contentDigest = upstreamSkillDigest(cachedSkill);
    fs.writeFileSync(
      path.join(previousRuntimeRoot, "catalog", "skills.json"),
      `${JSON.stringify({ upstreams: { "agent-deck": source } })}\n`
    );
    fs.appendFileSync(path.join(cachedSkill, "SKILL.md"), "modified\n");

    assert.throws(
      () => provisionPinnedUpstreamSkill({
        plan,
        runtime,
        previousRuntimeRoots: [previousRuntimeRoot],
        env: { PATH: "" }
      }),
      /Could not run git/
    );
    assert.equal(fs.existsSync(path.join(runtime.root, "skills", "agent-deck")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("source-installed links target the exact stable current paths", t => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const targetSkill = path.join(fixture.home, ".agents", "skills", "handoff");
    if (!fs.lstatSync(targetSkill).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const stableSource = path.join(fixture.dataRoot, "current", "skills", "handoff");
    assert.equal(fs.readlinkSync(targetSkill), stableSource);
    assert.notEqual(fs.realpathSync(targetSkill), path.join(rootDir, "skills", "handoff"));

    const state = readState(fixture);
    assert.equal(state.channel, "development");
    assert.deepEqual(state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff, {
      mode: "link",
      source: stableSource
    });
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("rerunning source-install refreshes shared source-installed links; purge then release install freezes that revision", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    const targetSkill = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const sharedSkill = path.join(fixture.dataRoot, "current", "skills", "handoff");

    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    assert.equal(fs.readlinkSync(path.dirname(targetSkill)), sharedSkill);
    const editableSource = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.appendFileSync(editableSource, "\n<!-- live-checkout-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    assert.equal(fs.readlinkSync(path.dirname(targetSkill)), sharedSkill);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(path.dirname(targetSkill)), false);

    runCheckout(["install", "--skill", "handoff", "--target", "general"]);
    assert.equal(fs.lstatSync(path.dirname(targetSkill)).isSymbolicLink(), false);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);
    fs.appendFileSync(editableSource, "\n<!-- post-install-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /post-install-marker/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("release and source channels cannot silently switch", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    for (const argumentsList of [
      ["update", "--skill", "handoff", "--target", "general"],
      ["update", "--force", "--skill", "handoff", "--target", "general"],
      ["update", "--no-launcher", "--skill", "handoff", "--target", "general"],
      ["install", "--skill", "handoff", "--target", "general"]
    ]) {
      assert.throws(
        () => run(argumentsList, fixture.environment),
        /Refusing to switch channel from "source" to "release"/
      );
    }
    fs.rmSync(path.join(fixture.dataRoot, "current"), { force: true });
    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to switch channel from "source" to "release"/
    );

    run(["uninstall", "--purge"], fixture.environment);
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.throws(
      () => run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to switch channel from "release" to "source"/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install keeps rollback-readable state and repairs the transitional source token", () => {
  const fixture = environmentFixture();
  try {
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const state = readState(fixture);
    assert.equal(state.channel, "development");

    state.channel = "source";
    craftState(fixture, state);

    run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.equal(readState(fixture).channel, "development");

    const transitionalState = readState(fixture);
    transitionalState.channel = "source";
    craftState(fixture, transitionalState);
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.equal(readState(fixture).channel, "development");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install restores a removed current link and its recorded launcher link", async t => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "multi-agent-protocol", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const commands = [[path.join(fixture.localBin, "agentgear"), "launcher"]];
    if (commands.some(([command]) => !fs.lstatSync(command).isSymbolicLink())) {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    const oldRelease = fs.realpathSync(current);
    const state = readState(fixture);
    for (const [command, kind] of commands) {
      assert.equal(state.commands[command].kind, kind);
      assert.equal(state.commands[command].mode, "link");
    }

    fs.rmSync(current, { force: true });
    assert.equal(pathExists(current), false);
    assert.equal(fs.existsSync(oldRelease), true);
    for (const [command] of commands) {
      assert.equal(pathExists(command), true);
      assert.equal(fs.existsSync(command), false);
    }

    runCheckout(["source-install", "--skill", "multi-agent-protocol", "--target", "general"]);

    assert.equal(fs.existsSync(current), true);
    assert.notEqual(fs.realpathSync(current), oldRelease);
    for (const [command] of commands) assert.equal(fs.existsSync(command), true);
    assert.equal(
      fs.realpathSync(path.join(fixture.localBin, "agentgear")),
      path.join(fs.realpathSync(current), "bin", "agentgear.mjs")
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("a dangling current blocks install, update, and source-install; full purge removes it", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);

    runCheckout(["install", "--skill", "handoff", "--target", "general"]);
    const current = path.join(fixture.dataRoot, "current");
    const oldRelease = fs.realpathSync(current);
    fs.rmSync(oldRelease, { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["update", "--skill", "handoff", "--target", "general"]),
      /Inventoried release is missing or mismatched/
    );
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "general"]),
      /Inventoried release is missing or mismatched/
    );

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(current), false);
    assert.equal(pathExists(fixture.stateFile), false);

    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    const sourceCurrent = path.join(fixture.dataRoot, "current");
    const sourceRelease = fs.realpathSync(sourceCurrent);
    fs.rmSync(sourceRelease, { recursive: true, force: true });
    assert.throws(
      () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
      /Inventoried release is missing or mismatched/
    );
    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(sourceCurrent), false);
    assert.equal(pathExists(fixture.stateFile), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("full purge removes managed skills and runtime artifacts but preserves unowned files", () => {
  const fixture = environmentFixture();
  const unmanagedSkill = path.join(fixture.home, ".agents", "skills", "not-managed-by-agentgear");
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    fs.mkdirSync(unmanagedSkill, { recursive: true });
    fs.writeFileSync(path.join(unmanagedSkill, "SKILL.md"), "# Keep me\n");
    fs.writeFileSync(path.join(fixture.dataRoot, "user-note.txt"), "keep\n");

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.doesNotMatch(purge.stdout, /permission_migration_required/);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "multi-agent-protocol")), false);
    assert.equal(fs.existsSync(unmanagedSkill), true);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "agent-deck-workflow-init-permissions")), false);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "releases")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "user-note.txt")), true);
    assert.equal(fs.existsSync(fixture.stateFile), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("purge preserves locally changed copied skills; --force never broadens purge ownership", () => {
  const fixture = environmentFixture();
  const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
  const launcher = path.join(fixture.localBin, "agentgear");
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.appendFileSync(skillFile, "\nLocal change\n");

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.match(purge.stdout, /preserved locally changed skill/);
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(pathExists(launcher), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), true);
    assert.equal(fs.existsSync(fixture.stateFile), true);

    const forced = spawnAgentgear(["uninstall", "--purge", "--force"], fixture, fixture.environment);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /preserved locally changed skill/);
    assert.equal(fs.existsSync(skillFile), true);

    assert.throws(
      () => run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to remove locally changed skill/
    );
    assert.throws(
      () => run(["uninstall", "--force", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to remove locally changed skill/
    );
    assert.equal(fs.existsSync(skillFile), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("targeted purge retains shared runtime while another target remains managed", () => {
  const fixture = environmentFixture();
  const launcher = path.join(fixture.localBin, "agentgear");
  try {
    run(["install", "--skill", "handoff", "--target", "general,claude"], fixture.environment);
    run(["uninstall", "--purge", "--target", "general"], fixture.environment);

    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "handoff")), false);
    assert.equal(fs.existsSync(path.join(fixture.home, ".claude", "skills", "handoff")), true);
    assert.equal(pathExists(launcher), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), true);
    assert.equal(fs.existsSync(fixture.stateFile), true);

    run(["uninstall", "--purge"], fixture.environment);
    assert.equal(fs.existsSync(path.join(fixture.home, ".claude", "skills", "handoff")), false);
    assert.equal(pathExists(launcher), false);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("ordinary uninstall restores removed skills when state persistence fails", () => {
  const fixture = environmentFixture();
  const originalWrite = fs.writeFileSync;
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousSkill = fs.readFileSync(skillFile, "utf8");
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.writeFileSync = (filePath, ...argumentsList) => {
      if (String(filePath).includes("installs.json")) {
        throw new Error("simulated uninstall state write failure");
      }
      return originalWrite(filePath, ...argumentsList);
    };

    assert.throws(
      () => run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment),
      /simulated uninstall state write failure/
    );
    fs.writeFileSync = originalWrite;

    assert.equal(fs.readFileSync(skillFile, "utf8"), previousSkill);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("targeted purge restores removed skills when state persistence fails", () => {
  const fixture = environmentFixture();
  const originalWrite = fs.writeFileSync;
  try {
    run(["install", "--skill", "handoff", "--target", "general,claude"], fixture.environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousSkill = fs.readFileSync(skillFile, "utf8");
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.writeFileSync = (filePath, ...argumentsList) => {
      if (String(filePath).includes("installs.json")) {
        throw new Error("simulated purge state write failure");
      }
      return originalWrite(filePath, ...argumentsList);
    };

    assert.throws(
      () => run(["uninstall", "--purge", "--target", "general"], fixture.environment),
      /simulated purge state write failure/
    );
    fs.writeFileSync = originalWrite;

    assert.equal(fs.readFileSync(skillFile, "utf8"), previousSkill);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("full purge derives candidates only from the inventory and ignores marker-shaped look-alikes", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const lookAlike = path.join(fixture.releasesRoot, "0.9.0-1700000000000-lookalike");
    fs.mkdirSync(lookAlike, { recursive: true });
    fs.writeFileSync(path.join(lookAlike, ".agentgear-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      releaseId: "0.9.0-1700000000000-lookalike"
    }));

    run(["uninstall", "--purge"], fixture.environment);
    assert.equal(fs.existsSync(path.join(fixture.releasesRoot, "0.9.0-1700000000000-lookalike")), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
    assert.equal(fs.existsSync(fixture.stateFile), false);
    assert.equal(fs.existsSync(fixture.releasesRoot), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("an explicit-last-target purge preflights the runtime before deleting anything", () => {
  const fixture = environmentFixture();
  const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const state = readState(fixture);
    const releaseRoot = path.join(fixture.releasesRoot, state.releases[0]);
    fs.writeFileSync(
      path.join(releaseRoot, ".agentgear-runtime.json"),
      JSON.stringify({ schemaVersion: 1, releaseId: "tampered" })
    );
    const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");

    const purge = spawnAgentgear(
      ["uninstall", "--purge", "--target", "general"],
      fixture,
      fixture.environment
    );
    assert.equal(purge.status, 1);
    assert.match(purge.stdout, /Purge incomplete/);
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), true);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("ordinary uninstall validates the whole scope before deleting anything", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--pack", "core", "--target", "general"], fixture.environment);
    const handoffFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const earlierFiles = [
      "commit-staged", "explain-for-me", "explore-defects"
    ].map(skill => path.join(fixture.home, ".agents", "skills", skill, "SKILL.md"));
    fs.appendFileSync(handoffFile, "\nLocal change\n");
    const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");

    assert.throws(
      () => run(["uninstall", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to remove locally changed skill/
    );

    for (const earlierFile of earlierFiles) {
      assert.equal(fs.existsSync(earlierFile), true);
    }
    assert.equal(fs.existsSync(handoffFile), true);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("full purge preflights the runtime first and aborts incomplete on a recorded release mismatch", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const state = readState(fixture);
    const releaseRoot = path.join(fixture.releasesRoot, state.releases[0]);
    fs.writeFileSync(
      path.join(releaseRoot, ".agentgear-runtime.json"),
      JSON.stringify({ schemaVersion: 1, releaseId: "tampered" })
    );

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 1);
    assert.match(purge.stdout, /preserved mismatched release/);
    assert.match(purge.stdout, /Purge incomplete/);
    assert.equal(fs.existsSync(releaseRoot), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), true);
    assert.equal(fs.existsSync(fixture.stateFile), true);
    // The preflight preserves every external artifact too: no partial teardown.
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md")), true);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), true);
    assert.deepEqual(readState(fixture).releases, state.releases);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("state loss beside managed runtime data blocks all publication commands", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    fs.rmSync(fixture.stateFile);

    for (const argumentsList of [
      ["install", "--skill", "handoff", "--target", "general"],
      ["update", "--skill", "handoff", "--target", "general"],
      ["source-install", "--skill", "handoff", "--target", "general"]
    ]) {
      assert.throws(
        () => run(argumentsList, fixture.environment),
        /Installation state is missing beside managed runtime data/
      );
    }
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), true);

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 1, purge.stderr);
    assert.match(purge.stderr, /Installation state is missing beside managed runtime data/);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("XDG alias changes fail without adoption; restoring the original environment works", () => {
  const fixture = environmentFixture();
  const physicalDataHome = path.join(fixture.temporary, "physical-data");
  const firstAlias = path.join(fixture.temporary, "data-first");
  const secondAlias = path.join(fixture.temporary, "data-second");
  const environment = {
    HOME: fixture.home,
    XDG_DATA_HOME: firstAlias,
    XDG_STATE_HOME: fixture.environment.XDG_STATE_HOME
  };
  try {
    fs.mkdirSync(physicalDataHome, { recursive: true });
    for (const alias of [firstAlias, secondAlias]) {
      fs.symlinkSync(physicalDataHome, alias, process.platform === "win32" ? "junction" : "dir");
    }
    run(["install", "--skill", "handoff", "--target", "general"], environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const originalContent = fs.readFileSync(skillFile, "utf8");
    const firstCurrent = path.join(firstAlias, "agentgear", "current");

    environment.XDG_DATA_HOME = secondAlias;
    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "general"], environment),
      /Invalid installation state .*linked command target must be exactly/
    );
    assert.equal(fs.readFileSync(skillFile, "utf8"), originalContent);
    assert.equal(pathExists(firstCurrent), true);

    environment.XDG_DATA_HOME = firstAlias;
    run(["update", "--skill", "handoff", "--target", "general"], environment);
    assert.equal(pathExists(firstCurrent), true);
    assert.equal(fs.existsSync(skillFile), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("whole data root loss fails; full purge then reinstall recovers", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true });

    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "general"], fixture.environment),
      /data root is missing/
    );

    run(["uninstall", "--purge"], fixture.environment);
    assert.equal(fs.existsSync(fixture.stateFile), false);
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md")), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("mutating commands reject malformed, legacy, and escaping state before any mutation", () => {
  const fixture = environmentFixture();
  const targetRoot = path.join(fixture.home, ".agents", "skills");
  const currentSource = path.join(fixture.dataRoot, "current", "skills", "handoff");
  const launcher = path.join(fixture.localBin, "agentgear");
  const currentTarget = path.join(fixture.dataRoot, "current", "bin", "agentgear.mjs");
  const valid = () => ({
    schemaVersion: 3,
    skillPrefix: null,
    channel: "release",
    releases: ["0.1.0-1786000000000-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    targets: {
      [targetRoot]: {
        skills: {
          handoff: { mode: "link", source: currentSource }
        }
      }
    },
    commands: {
      [launcher]: { kind: "launcher", mode: "link", target: currentTarget }
    }
  });

  const invalidStates = [
    { ...valid(), schemaVersion: 1 },
    { ...valid(), extraField: true },
    {
      ...valid(),
      targets: { [targetRoot]: { ...valid().targets[targetRoot], futureMetadata: { version: 1 } } }
    },
    {
      ...valid(),
      skillPrefix: "../evil"
    },
    {
      ...valid(),
      skillPrefix: "a".repeat(64),
      targets: {
        [targetRoot]: {
          skills: {
            handoff: { mode: "copy", fingerprint: `sha256-v1:${"0".repeat(64)}` }
          }
        }
      }
    },
    { ...valid(), channel: "staging" },
    { ...valid(), releases: ["0.1.0-1786000000000-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/../evil"] },
    { ...valid(), releases: ["b", "a"] },
    { ...valid(), releases: ["a", "a"] },
    { ...valid(), targets: { [targetRoot]: { skills: { "../evil": { mode: "link", source: currentSource } } } } },
    { ...valid(), targets: { [targetRoot]: { skills: { "a/b": { mode: "link", source: currentSource } } } } },
    {
      ...valid(),
      commands: {
        [path.join(fixture.localBin, "other-command")]: { kind: "launcher", mode: "link", target: currentTarget }
      }
    },
    { ...valid(), commands: { [launcher]: { kind: "workflow-helper", mode: "link", target: currentTarget } } },
    {
      ...valid(),
      targets: { [targetRoot]: { skills: { handoff: { mode: "copy", fingerprint: "sha256-v1:zzz" } } } }
    },
    { ...valid(), targets: { [targetRoot]: { skills: { handoff: { mode: "link", source: "/tmp/not-current" } } } } },
    { ...valid(), targets: { [targetRoot]: { skills: { handoff: { mode: "link", source: "relative" } } } } },
    { ...valid(), targets: { [`${fixture.home}/.//agents/skills`]: valid().targets[targetRoot] } },
    { ...valid(), targets: { [targetRoot]: { skills: { handoff: { mode: "link", source: path.join(currentSource, "extra") } } } } },
    {
      ...valid(),
      commands: {
        [launcher]: { kind: "launcher", mode: "link", target: path.join(fixture.dataRoot, "current", "skills", "handoff", "SKILL.md") }
      }
    },
    {
      ...valid(),
      commands: {
        [launcher]: { kind: "launcher", mode: "link", target: path.join(currentTarget, "extra") }
      }
    },
    {
      ...valid(),
      commands: {
        ...valid().commands,
        [path.join(fixture.localBin, "adwf-send-and-wake")]: {
          kind: "workflow-helper",
          mode: "link",
          target: currentTarget
        }
      }
    },
    {
      ...valid(),
      commands: {
        [launcher]: {
          kind: "launcher",
          mode: "wrapper",
          target: path.join(fixture.releasesRoot, "0.1.0-1786000000000-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "skills", "handoff", "SKILL.md"),
          fingerprint: `sha256-v1:${"0".repeat(64)}`
        }
      }
    },
    {
      ...valid(),
      commands: {
        [launcher]: {
          kind: "launcher",
          mode: "link",
          target: path.join(fixture.dataRoot, "x", "agentgear", "current", "bin", "agentgear.mjs")
        }
      }
    }
  ];

  const mutatingCommands = [
    ["install", "--skill", "handoff", "--target", "general"],
    ["update", "--skill", "handoff", "--target", "general"],
    ["source-install", "--skill", "handoff", "--target", "general"],
    ["uninstall", "--skill", "handoff", "--target", "general"],
    ["uninstall", "--purge"]
  ];
  try {
    for (const [index, invalidState] of invalidStates.entries()) {
      craftState(fixture, invalidState);
      for (const argumentsList of mutatingCommands) {
        assert.throws(
          () => run(argumentsList, fixture.environment),
          /Invalid installation state/,
          `state variant ${index} with ${argumentsList.join(" ")}`
        );
      }
      assert.throws(
        () => run(["install", "--force", "--skill", "handoff", "--target", "general"], fixture.environment),
        /Invalid installation state/,
        `state variant ${index} with --force`
      );
      assert.equal(pathExists(fixture.dataRoot), false, `no data root mutation for variant ${index}`);
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("status reports invalid state path and reason without mutating anything", () => {
  const fixture = environmentFixture();
  try {
    craftState(fixture, { schemaVersion: 1, channel: null, releases: [], targets: {}, commands: {} });
    const status = spawnAgentgear(["status"], fixture, fixture.environment);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Invalid installation state: .*installs\.json/);
    assert.match(status.stdout, /unsupported schemaVersion/);
    assert.equal(pathExists(fixture.dataRoot), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("fresh no-link installation uses copy fallback with physical-release wrappers", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    fs.symlinkSync = originalSymlink;

    const skill = path.join(fixture.home, ".agents", "skills", "handoff");
    const launcher = path.join(fixture.localBin, "agentgear");
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);

    const state = readState(fixture);
    assert.equal(state.channel, "development");
    const skillRecord = state.targets[path.join(fixture.home, ".agents", "skills")].skills.handoff;
    assert.deepEqual(Object.keys(skillRecord).sort(), ["fingerprint", "mode"]);
    assert.equal(skillRecord.mode, "copy");
    assert.match(skillRecord.fingerprint, /^sha256-v1:[0-9a-f]{64}$/);
    const launcherRecord = state.commands[launcher];
    assert.deepEqual(Object.keys(launcherRecord).sort(), ["fingerprint", "kind", "mode", "target"]);
    assert.equal(launcherRecord.kind, "launcher");
    assert.equal(launcherRecord.mode, "wrapper");
    assert.match(launcherRecord.target, /releases[\\/][^\\/]+[\\/]bin[\\/]agentgear\.mjs$/);
    assert.match(launcherRecord.fingerprint, /^sha256-v1:[0-9a-f]{64}$/);

    const launched = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...fixture.environment }
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /Packs:/);

    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- copied-link-marker -->\n");
    try {
      fs.symlinkSync = () => {
        const error = new Error("links unavailable");
        error.code = "EPERM";
        throw error;
      };
      runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    } finally {
      fs.symlinkSync = originalSymlink;
    }
    assert.match(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), /copied-link-marker/);

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(skill), false);
    assert.equal(pathExists(launcher), false);
    assert.equal(pathExists(fixture.stateFile), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("shared records block shared-to-fallback even with --no-launcher; purge then fresh fallback succeeds", async t => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    const current = path.join(fixture.dataRoot, "current");
    if (!fs.lstatSync(path.join(fixture.home, ".agents", "skills", "handoff")).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const previousRuntime = fs.realpathSync(current);
    const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");

    fs.symlinkSync = (target, destination, type) => {
      if (path.basename(destination).startsWith(".runtime-link-probe.")) {
        const error = new Error("directory links unavailable");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    for (const argumentsList of [
      ["source-install", "--skill", "review-code", "--target", "general"],
      ["source-install", "--no-launcher", "--skill", "review-code", "--target", "general"],
      ["source-install", "--pack", "all", "--target", "general,claude"]
    ]) {
      assert.throws(
        () => runCheckout(argumentsList),
        /Cannot use copy fallback while shared runtime records remain/
      );
    }
    fs.symlinkSync = originalSymlink;

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "review-code")), false);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);

    runCheckout(["uninstall", "--purge"]);
    fs.symlinkSync = (target, destination, type) => {
      if (path.basename(destination).startsWith(".runtime-link-probe.")) {
        const error = new Error("directory links unavailable");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    fs.symlinkSync = originalSymlink;
    assert.equal(fs.lstatSync(path.join(fixture.home, ".agents", "skills", "handoff")).isSymbolicLink(), false);
    assert.equal(pathExists(current), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("release updates do not fall back when a copied-skill target rejects links", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    const targetParent = path.join(fixture.home, ".agents", "skills");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- release-no-fallback -->\n");

    fs.symlinkSync = (target, destination, type) => {
      if (
        path.dirname(path.resolve(destination)) === targetParent
        && path.basename(destination).startsWith(".runtime-link-probe.")
      ) {
        const error = new Error("simulated target-parent link denial");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["install", "--skill", "handoff", "--target", "general"]);
    fs.symlinkSync = originalSymlink;

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.match(
      fs.readFileSync(path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md"), "utf8"),
      /release-no-fallback/
    );
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source install falls back when only a target parent rejects links", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    const targetParent = path.join(fixture.home, ".agents", "skills");

    fs.symlinkSync = (target, destination, type) => {
      if (
        path.dirname(path.resolve(destination)) === targetParent
        && path.basename(destination).startsWith(".runtime-link-probe.")
      ) {
        const error = new Error("simulated target-parent link denial");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);
    fs.symlinkSync = originalSymlink;

    const skill = path.join(fixture.home, ".agents", "skills", "handoff");
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
    const state = readState(fixture);
    assert.equal(state.targets[targetParent].skills.handoff.mode, "copy");
    assert.equal(state.commands[path.join(fixture.localBin, "agentgear")].mode, "wrapper");
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("stored fingerprints verify a wrapper from an older template; tampered wrappers are unowned", () => {
  const fixture = environmentFixture();
  const originalSymlink = fs.symlinkSync;
  try {
    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.symlinkSync = originalSymlink;

    const launcher = path.join(fixture.localBin, "agentgear");
    const state = readState(fixture);
    const recorded = state.commands[launcher];
    const oldReleaseId = state.releases[0];
    assert.equal(recorded.mode, "wrapper");

    // Simulate a later wrapper template: replace the artifact and store the
    // fingerprint of the new bytes so the exact ownership evidence still
    // verifies the foreign template.
    fs.writeFileSync(launcher, "#!/usr/bin/env node\nconsole.log('older-template-wrapper');\n");
    fs.chmodSync(launcher, 0o755);
    const foreign = {
      ...recorded,
      fingerprint: wrapperFingerprint(launcher)
    };
    state.commands[launcher] = foreign;
    fs.writeFileSync(fixture.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.symlinkSync = originalSymlink;
    const refreshed = readState(fixture);
    assert.notEqual(refreshed.commands[launcher].fingerprint, foreign.fingerprint);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);

    fs.appendFileSync(launcher, "\n// tampered\n");
    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    assert.throws(
      () => run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to replace unmanaged launcher/
    );
    fs.symlinkSync = originalSymlink;
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("purge preserves an unverifiable command and reports it", () => {
  const fixture = environmentFixture();
  const originalSymlink = fs.symlinkSync;
  try {
    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment);
    fs.symlinkSync = originalSymlink;

    const launcher = path.join(fixture.localBin, "agentgear");
    fs.appendFileSync(launcher, "\n// tampered\n");

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.match(purge.stdout, /preserved unverifiable launcher/);
    assert.equal(pathExists(launcher), true);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "handoff")), false);
    assert.equal(fs.existsSync(fixture.stateFile), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install validates documented scripts required by active shared skills", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "execute-plan", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "prepare-workspaces.mjs"));

    assert.throws(
      () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
      /missing or unsafe: .*prepare-workspaces\.mjs/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(
      fs.realpathSync(path.join(fixture.home, ".agents", "skills", "execute-plan")),
      path.join(previousRuntime, "skills", "execute-plan")
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install validates transitive dependencies of an active launcher", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const launcher = path.join(fixture.localBin, "agentgear");
    const previousRuntime = fs.realpathSync(current);
    const previousLauncher = fs.realpathSync(launcher);
    fs.rmSync(path.join(checkout, "cli", "lib", "runtime.mjs"));

    assert.throws(
      () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
      /cli[\\/]lib[\\/]runtime\.mjs is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.realpathSync(launcher), previousLauncher);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install validates every recorded shared link, including skills outside its selection", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const handoff = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["source-install", "--skill", "delegate-code-task", "--target", "general"]),
      /requires skills[\\/]handoff[\\/]SKILL\.md/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(handoff), true);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("source-install validates commands in documents referenced by active skills", async t => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "multi-agent-protocol", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const activeSkill = path.join(fixture.home, ".agents", "skills", "multi-agent-protocol");
    if (!fs.lstatSync(activeSkill).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "resolve-tool-command.js"));

    assert.throws(
      () => runCheckout(["source-install", "--skill", "handoff", "--target", "general"]),
      /resolve-tool-command\.js is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(
      fs.realpathSync(activeSkill),
      path.join(previousRuntime, "skills", "multi-agent-protocol")
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("--no-launcher still validates active launcher entrypoints", async () => {
  for (const [missingPath, errorPattern] of [
    [path.join("bin", "agentgear.mjs"), /requires bin[\\/]agentgear\.mjs/],
    [path.join("cli", "agentgear.mjs"), /cli[\\/]agentgear\.mjs is missing or is not a file/]
  ]) {
    const fixture = environmentFixture();
    const checkout = path.join(fixture.temporary, "checkout");
    try {
      fs.cpSync(rootDir, checkout, {
        recursive: true,
        filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
      });
      const runCheckout = await checkoutRunner(checkout, fixture.environment);
      runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);

      const current = path.join(fixture.dataRoot, "current");
      const launcher = path.join(fixture.localBin, "agentgear");
      const previousRuntime = fs.realpathSync(current);
      const previousState = fs.readFileSync(fixture.stateFile, "utf8");
      fs.rmSync(path.join(checkout, missingPath));

      assert.throws(
        () => runCheckout(["source-install", "--skill", "handoff", "--target", "general", "--no-launcher"]),
        errorPattern
      );

      assert.equal(fs.realpathSync(current), previousRuntime);
      assert.equal(fs.existsSync(launcher), true);
      assert.equal(fs.realpathSync(launcher), path.join(previousRuntime, "bin", "agentgear.mjs"));
      assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
    } finally {
      fs.rmSync(fixture.temporary, { recursive: true, force: true });
    }
  }
});

test("source-install ignores a deleted project target retained in installation state", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const project = path.join(fixture.temporary, "project");
  const projectTarget = path.join(project, ".agents", "skills");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    fs.mkdirSync(project, { recursive: true });
    runCheckout([
      "source-install", "--skill", "handoff", "--target", "general",
      "--scope", "project", "--project", project
    ]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    assert.equal(pathExists(path.join(projectTarget, "handoff")), true);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["source-install", "--pack", "workflow", "--target", "general"]);

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.equal(pathExists(projectTarget), false);
    const state = readState(fixture);
    assert.equal(state.targets[projectTarget].skills.handoff.mode, "link");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("authoritative source-install reconciliation rejects state-recorded skill links pinned to an old physical release", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const target = path.join(fixture.home, ".agents", "skills", "handoff");
    const previousRuntime = fs.realpathSync(current);
    const oldReleaseTarget = fs.realpathSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(oldReleaseTarget, target, process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["source-install", "--pack", "workflow", "--target", "general"]),
      /Refusing to withdraw locally changed skill/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.realpathSync(target), oldReleaseTarget);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("a failed target write restores replaced destinations and discards the pending release", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalCopy = fs.cpSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);

    runCheckout(["install", "--skill", "handoff", "--target", "general,claude"]);
    const current = path.join(fixture.dataRoot, "current");
    const codexSkill = path.join(fixture.home, ".agents", "skills", "handoff");
    const claudeSkill = path.join(fixture.home, ".claude", "skills", "handoff", "SKILL.md");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- target-write-must-not-publish -->\n");

    fs.cpSync = (source, destination, copyOptions) => {
      if (path.resolve(destination) === codexSkill) {
        const error = new Error("simulated target write failure");
        error.code = "EIO";
        throw error;
      }
      return originalCopy(source, destination, copyOptions);
    };
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "general"]),
      /simulated target write failure/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.doesNotMatch(fs.readFileSync(claudeSkill, "utf8"), /target-write-must-not-publish/);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
    assert.equal(fs.readdirSync(fixture.releasesRoot).length, 1);
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("a launcher write failure restores copied skills that were already replaced", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const targetSkill = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const launcher = path.join(fixture.localBin, "agentgear");
    const previousRuntime = fs.realpathSync(current);
    const previousSkill = fs.readFileSync(targetSkill, "utf8");
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- launcher-rollback-marker -->\n");

    fs.symlinkSync = (target, destination, type) => {
      if (path.resolve(destination) === launcher) {
        const error = new Error("simulated launcher write failure");
        error.code = "EIO";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "general"]),
      /simulated launcher write failure/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.readFileSync(targetSkill, "utf8"), previousSkill);
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /launcher-rollback-marker/);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
    assert.equal(fs.existsSync(launcher), true);
    assert.equal(fs.readdirSync(fixture.releasesRoot).length, 1);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("a state-write failure keeps prior state, current, and inventory", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalWrite = fs.writeFileSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const targetSkill = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousRuntime = fs.realpathSync(current);
    const previousSkill = fs.readFileSync(targetSkill, "utf8");
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- state-write-must-not-publish -->\n");

    fs.writeFileSync = (filePath, ...argumentsList) => {
      if (String(filePath).includes("installs.json")) {
        const error = new Error("simulated state write failure");
        error.code = "EIO";
        throw error;
      }
      return originalWrite(filePath, ...argumentsList);
    };
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "general"]),
      /simulated state write failure/
    );
    fs.writeFileSync = originalWrite;

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.readFileSync(targetSkill, "utf8"), previousSkill);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
    assert.equal(fs.readdirSync(fixture.releasesRoot).length, 1);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("ESM fallback wrappers stay on current when publication fails", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalSymlink = fs.symlinkSync;
  const originalRename = fs.renameSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.mkdirSync(fixture.home, { recursive: true });
    fs.writeFileSync(path.join(fixture.home, "package.json"), '{"type":"module"}\n');
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    const localBin = fixture.localBin;
    const launcher = path.join(localBin, "agentgear");
    fs.symlinkSync = (target, destination, type) => {
      if (path.dirname(path.resolve(destination)) === localBin) {
        const error = new Error("file links unavailable");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["source-install", "--skill", "multi-agent-protocol", "--target", "general"]);
    fs.symlinkSync = originalSymlink;

    const current = path.join(fixture.dataRoot, "current");
    const launcherSource = fs.readFileSync(launcher, "utf8");
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    assert.doesNotMatch(launcherSource, /require\s*\(/);
    assert.equal(launcherSource.includes(JSON.stringify(path.join(current, "bin", "agentgear.mjs"))), true);
    const launched = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...fixture.environment }
    });
    assert.equal(launched.status, 0, launched.stderr);

    const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");
    const previousRuntime = fs.realpathSync(current);
    fs.appendFileSync(path.join(checkout, "skills", "multi-agent-protocol", "SKILL.md"), "\n<!-- publish-must-not-appear -->\n");
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === current) {
        const error = new Error("simulated publish failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, destination);
    };
    assert.throws(
      () => runCheckout(["source-install", "--skill", "multi-agent-protocol", "--target", "general"]),
      /simulated publish failure/
    );
    fs.renameSync = originalRename;

    const afterFailure = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...fixture.environment }
    });
    assert.equal(afterFailure.status, 0, afterFailure.stderr);
    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.readFileSync(launcher, "utf8"), launcherSource);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);
    assert.equal(fs.readdirSync(fixture.releasesRoot).length, 1);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.renameSync = originalRename;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("a failed rollback retains the pending release unrecorded and blocks later runs", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["install", "--skill", "handoff", "--target", "general"]);
    const launcher = path.join(fixture.localBin, "agentgear");
    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- rollback-marker -->\n");

    fs.writeFileSync = (filePath, ...argumentsList) => {
      if (String(filePath).includes("installs.json")) {
        const error = new Error("simulated state write failure");
        error.code = "EIO";
        throw error;
      }
      return originalWrite(filePath, ...argumentsList);
    };
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === launcher && String(source).includes("agentgear-backup")) {
        const error = new Error("simulated restore failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, destination);
    };
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "general"]),
      /partial rollback: retained staged release .* without recording it \(manual recovery required\)/
    );
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
    const retained = fs.readdirSync(fixture.releasesRoot).filter(name => !name.startsWith("."));
    assert.equal(retained.length, 2);
    const priorRelease = readState(fixture).releases[0];
    const retainedRelease = retained.find(name => name !== priorRelease);
    const marker = JSON.parse(fs.readFileSync(
      path.join(fixture.releasesRoot, retainedRelease, ".agentgear-runtime.json"),
      "utf8"
    ));
    assert.equal(marker.releaseId, retainedRelease);

    assert.throws(
      () => runCheckout(["update", "--skill", "handoff", "--target", "general"]),
      /Unrecorded marked release present/
    );
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("runtime stages use distinct release IDs in one clock tick", () => {
  const fixture = environmentFixture();
  const originalNow = Date.now;
  try {
    Date.now = () => 12345;
    const first = stageRuntime({ sourceRoot: rootDir, env: fixture.environment });
    const second = stageRuntime({ sourceRoot: rootDir, env: fixture.environment });

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.root, second.root);
    assert.match(first.id, /-\d{8}-[A-Za-z0-9_-]{8}$/);
    assert.ok(first.id.length < 32);
    assert.equal(fs.existsSync(first.root), true);
    assert.equal(fs.existsSync(second.root), true);
    const marker = JSON.parse(fs.readFileSync(path.join(first.root, ".agentgear-runtime.json"), "utf8"));
    assert.deepEqual(marker, { schemaVersion: 1, releaseId: first.id });
  } finally {
    Date.now = originalNow;
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("runtime staging excludes volatile build directories", () => {
  const fixture = environmentFixture();
  const sourceRoot = path.join(fixture.temporary, "source");
  try {
    fs.mkdirSync(path.join(sourceRoot, ".dist-concurrent", "universal"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "skills", "fixture"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"version":"0.1.0"}\n');
    fs.writeFileSync(path.join(sourceRoot, ".dist-concurrent", "universal", "partial"), "volatile");
    fs.writeFileSync(path.join(sourceRoot, "skills", "fixture", "SKILL.md"), "stable");

    const runtime = stageRuntime({ sourceRoot, env: fixture.environment });

    assert.equal(fs.existsSync(path.join(runtime.root, ".dist-concurrent")), false);
    assert.equal(fs.readFileSync(path.join(runtime.root, "skills", "fixture", "SKILL.md"), "utf8"), "stable");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("agentgear-source-install rejects staged and packaged sources; agentgear has no source-install subcommand", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["source-install", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    const { main: runtimeSourceInstallMain } = await import(
      `${pathToFileURL(path.join(current, "cli", "source-install.mjs")).href}?test=${Date.now()}`
    );
    const runRuntimeSourceInstall = argumentsList => {
      const original = {};
      for (const [key, value] of Object.entries(fixture.environment)) {
        original[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        runtimeSourceInstallMain(argumentsList);
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    assert.throws(
      () => runRuntimeSourceInstall(["--skill", "handoff", "--target", "general"]),
      /agentgear-source-install must be run from a source checkout/
    );
    assert.equal(fs.realpathSync(current), previousRuntime);

    const packagedSource = path.join(fixture.temporary, "packaged-source");
    fs.cpSync(rootDir, packagedSource, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.rmSync(path.join(packagedSource, ".agentgear-source-checkout"));
    const { main: packagedSourceInstallMain } = await import(
      `${pathToFileURL(path.join(packagedSource, "cli", "source-install.mjs")).href}?test=${Date.now()}`
    );
    assert.throws(
      () => invoke(packagedSourceInstallMain, ["--skill", "handoff", "--target", "general"], fixture.environment),
      /agentgear-source-install must be run from a source checkout/
    );
    assert.throws(
      () => invoke(main, ["source-install", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Unknown command: source-install/
    );
    assert.throws(
      () => invoke(main, ["install", "--source-install", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Unknown option: --source-install/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("the published package excludes the source-install entry point", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.bin), ["agentgear"]);
  assert.equal(packageJson.files.includes("bin/agentgear-source-install.mjs"), false);
  assert.equal(packageJson.files.includes("cli/source-install.mjs"), false);
  assert.equal(packageJson.scripts["source-install"], undefined);

  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-npm-cache-"));
  const pack = childProcess.spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", cache], {
    cwd: rootDir,
    encoding: "utf8"
  });
  try {
    assert.equal(pack.status, 0, pack.stderr);
    const files = JSON.parse(pack.stdout)
      .flatMap(entry => entry.files ?? [])
      .map(file => file.path);
    assert.equal(files.includes("bin/agentgear-source-install.mjs"), false);
    assert.equal(files.includes("cli/source-install.mjs"), false);
    assert.equal(files.includes("bin/agentgear.mjs"), true);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("source-install refuses an unrecorded dangling command at the stable current path", t => {
  const fixture = environmentFixture();
  const launcher = path.join(fixture.localBin, "agentgear");
  const expectedTarget = path.join(fixture.dataRoot, "current", "bin", "agentgear.mjs");
  try {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    try {
      fs.symlinkSync(expectedTarget, launcher, "file");
    } catch {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    assert.throws(
      () => run(["source-install", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to replace unmanaged launcher/
    );
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("install and update refuse an unmanaged current directory", () => {
  const fixture = environmentFixture();
  const launcher = path.join(fixture.localBin, "agentgear");
  try {
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    const current = path.join(fixture.dataRoot, "current");
    fs.rmSync(current, { force: true });
    const userLauncher = path.join(current, "bin", "agentgear.mjs");
    fs.mkdirSync(path.dirname(userLauncher), { recursive: true });
    fs.writeFileSync(userLauncher, "// user-managed launcher\n");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.rmSync(launcher, { force: true });
    fs.symlinkSync(userLauncher, launcher);

    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to replace unmanaged runtime path/
    );
    assert.throws(
      () => run(["install", "--force", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to replace unmanaged runtime path/
    );
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(launcher), fs.realpathSync(userLauncher));
    assert.equal(fs.readFileSync(userLauncher, "utf8"), "// user-managed launcher\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
