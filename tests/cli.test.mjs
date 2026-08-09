import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childProcessOutcome, main } from "../cli/agentgear.mjs";
import { main as linkMain } from "../cli/link.mjs";
import { loadCatalog } from "../cli/lib/catalog.mjs";
import { installSelection, resolveTargetRoots, selected } from "../cli/lib/installer.mjs";
import { parseOptions } from "../cli/lib/options.mjs";
import { directoryFingerprint, stageRuntime, wrapperFingerprint } from "../cli/lib/runtime.mjs";
import { deleteSession } from "../cli/lib/session-hosts.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const isLink = argumentsList[0] === "link";
  return invoke(isLink ? linkMain : main, isLink ? argumentsList.slice(1) : argumentsList, env);
}

async function checkoutRunner(checkout, environment) {
  const { main: checkoutMain } = await import(
    `${pathToFileURL(path.join(checkout, "cli", "agentgear.mjs")).href}?test=${Date.now()}`
  );
  const { main: checkoutLinkMain } = await import(
    `${pathToFileURL(path.join(checkout, "cli", "link.mjs")).href}?test=${Date.now()}`
  );
  return argumentsList => {
    const isLink = argumentsList[0] === "link";
    return invoke(
      isLink ? checkoutLinkMain : checkoutMain,
      isLink ? argumentsList.slice(1) : argumentsList,
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

function spawnAgentgearLink(argumentsList, fixture, environment) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(rootDir, "bin", "agentgear-link.mjs"), ...argumentsList],
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
      ["link", "--skill", "handoff", "--target", "general"],
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
      ["skills/handoff/SKILL.md", outside, /requires skills[\\/]handoff[\\/]SKILL\.md, which is missing from the staged snapshot or is not a regular file/],
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
          () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
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
      ["skills", "skills/handoff/SKILL.md", /requires skills[\\/]handoff[\\/]SKILL\.md, which is missing from the staged snapshot or is not a regular file/]
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
          () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
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
        () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
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
  assert.deepEqual(Object.keys(loadCatalog(rootDir).targets.targets), ["general", "claude", "kiro"]);
  for (const [target, directory] of [
    ["general", ".agents"],
    ["claude", ".claude"],
    ["kiro", ".kiro"]
  ]) {
    assert.equal(
      fs.existsSync(path.join(rootDir, "dist", target, directory, "skills", "handoff", "SKILL.md")),
      true
    );
  }
  for (const removedTarget of ["gemini", "opencode", "antigravity"]) {
    assert.equal(fs.existsSync(path.join(rootDir, "dist", removedTarget)), false);
  }
});

test("general and Claude are the default skill targets", () => {
  const fixture = environmentFixture();
  try {
    const targets = resolveTargetRoots(loadCatalog(rootDir), parseOptions([]), fixture.environment);
    assert.deepEqual(targets, [
      {
        name: "general",
        root: path.join(fixture.home, ".agents", "skills")
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
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("default installation reaches both default targets with every pack", () => {
  const fixture = environmentFixture();
  try {
    run(["install"], fixture.environment);
    for (const skillsRoot of [
      path.join(fixture.home, ".agents", "skills"),
      path.join(fixture.home, ".claude", "skills")
    ]) {
      assert.equal(fs.existsSync(path.join(skillsRoot, "handoff", "SKILL.md")), true);
      assert.equal(fs.existsSync(path.join(skillsRoot, "multi-agent-protocol", "SKILL.md")), true);
    }
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

test("agentgear-link help states every option default", () => {
  const fixture = environmentFixture();
  try {
    const result = spawnAgentgearLink(["--help"], fixture, fixture.environment);
    assert.equal(result.status, 0, result.stderr);
    for (const expectation of [
      /--pack NAME\s+Install one or more packs \(default: all\)/,
      /--skill NAME\s+Install named skills when --pack is omitted \(default: none\)/,
      /--target NAME\[,NAME\]\s+Select destinations \(default: general,claude\)/,
      /--scope global\|project\s+Use global or project destinations \(default: global\)/,
      /--project DIR\s+Project root for --scope project \(default: current directory\)/,
      /--dest DIR\s+Override one destination directory \(default: none; defaults to general\)/,
      /--force\s+Replace selected conflicting artifacts \(default: false\)/,
      /--no-launcher\s+Skip the global agentgear command and workflow helpers \(default: false\)/,
      /-h, --help\s+Show this help \(default: false\)/,
      /Available packs:/,
      /core\s+Standalone skills with no multi-agent workflow dependency/,
      /workflow\s+Multi-agent workflow skills using Waypost and one supported session host/,
      /browser\s+Browser-validation skills for the multi-agent workflow/,
      /all\s+Every maintained skill in this repository/
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

test("workflow doctor accepts either declared session host", () => {
  const fixture = environmentFixture();
  try {
    const bin = path.join(fixture.temporary, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["git", "node", "waypost", "thurbox-cli"]) writeExecutable(bin, command);
    const environment = { ...fixture.environment, PATH: bin };

    const thurboxReady = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(thurboxReady.status, 0, thurboxReady.stderr);
    assert.match(thurboxReady.stdout, /ok\s+session host thurbox \(thurbox-cli\)/);
    assert.match(thurboxReady.stdout, /Supported session host: thurbox\./);

    fs.rmSync(path.join(bin, "thurbox-cli"));
    const noHost = spawnAgentgear(["doctor", "--pack", "workflow"], fixture, environment);
    assert.equal(noHost.status, 1);
    assert.match(noHost.stdout, /Missing one supported session host: agent-deck or thurbox\./);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("release install copies skills, records schema-v2 state, and ordinary uninstall retains the runtime", () => {
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
      ["assess-tech-design", "commit-staged", "explain-for-me", "explore-defects"]
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

test("workflow installation provisions its explicit helper command", t => {
  const fixture = environmentFixture();
  try {
    run(["install", "--pack", "workflow", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "multi-agent-protocol", "SKILL.md")), true);
    const state = readState(fixture);
    for (const helper of ["adwf-send-and-wake"]) {
      const helperPath = path.join(fixture.localBin, helper);
      if (!fs.lstatSync(helperPath).isSymbolicLink()) {
        t.skip("file links are unavailable on this filesystem");
        return;
      }
      assert.match(fs.readlinkSync(helperPath), /agentgear[\\/]current[\\/]skills[\\/]multi-agent-protocol/);
      assert.equal(state.commands[helperPath].kind, "workflow-helper");
      assert.equal(state.commands[helperPath].mode, "link");
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
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
      /Refusing to retire locally changed legacy workflow helper/
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

test("workflow installation stages the declared Agent Deck upstream skill", () => {
  const fixture = environmentFixture();
  const bin = path.join(fixture.temporary, "bin");
  const installed = [];
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
      print: () => {},
      provisionUpstreamSkill: ({ plan, runtime }) => {
        installed.push(plan);
        const skillDir = path.join(runtime.root, "skills", plan.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Agent Deck\n");
      }
    });

    assert.deepEqual(installed.map(plan => plan.name), ["agent-deck"]);
    const skill = path.join(fixture.home, ".agents", "skills", "agent-deck", "SKILL.md");
    assert.equal(fs.existsSync(skill), true);
    assert.equal(
      readState(fixture).targets[path.join(fixture.home, ".agents", "skills")].skills["agent-deck"].mode,
      "copy"
    );

    run(["uninstall", "--pack", "workflow", "--target", "general"], fixture.environment);
    assert.equal(fs.existsSync(skill), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("developer links target the exact stable current paths", t => {
  const fixture = environmentFixture();
  try {
    run(["link", "--skill", "handoff", "--target", "general"], fixture.environment);
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

test("rerunning link refreshes shared developer links; purge then release install freezes that revision", async () => {
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

    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
    assert.equal(fs.readlinkSync(path.dirname(targetSkill)), sharedSkill);
    const editableSource = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.appendFileSync(editableSource, "\n<!-- live-checkout-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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

test("release and development channels cannot silently switch", () => {
  const fixture = environmentFixture();
  try {
    run(["link", "--skill", "handoff", "--target", "general"], fixture.environment);
    for (const argumentsList of [
      ["update", "--skill", "handoff", "--target", "general"],
      ["update", "--force", "--skill", "handoff", "--target", "general"],
      ["update", "--no-launcher", "--skill", "handoff", "--target", "general"],
      ["install", "--skill", "handoff", "--target", "general"]
    ]) {
      assert.throws(
        () => run(argumentsList, fixture.environment),
        /Refusing to switch channel from "development" to "release"/
      );
    }
    fs.rmSync(path.join(fixture.dataRoot, "current"), { force: true });
    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to switch channel from "development" to "release"/
    );

    run(["uninstall", "--purge"], fixture.environment);
    run(["install", "--skill", "handoff", "--target", "general"], fixture.environment);
    assert.throws(
      () => run(["link", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Refusing to switch channel from "release" to "development"/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link restores a removed current link and its recorded command links", async t => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const commands = [
      [path.join(fixture.localBin, "agentgear"), "launcher"],
      [path.join(fixture.localBin, "adwf-send-and-wake"), "workflow-helper"]
    ];
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

    runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]);

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

test("a dangling current blocks install, update, and link; full purge removes it", async () => {
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

    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
    const developmentCurrent = path.join(fixture.dataRoot, "current");
    const developmentRelease = fs.realpathSync(developmentCurrent);
    fs.rmSync(developmentRelease, { recursive: true, force: true });
    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
      /Inventoried release is missing or mismatched/
    );
    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(developmentCurrent), false);
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
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "multi-agent-protocol")), false);
    assert.equal(fs.existsSync(unmanagedSkill), true);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "agent-deck-workflow-init-permissions")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "adwf-send-and-wake")), false);
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
      ["link", "--skill", "handoff", "--target", "general"]
    ]) {
      assert.throws(
        () => run(argumentsList, fixture.environment),
        /Installation state is missing beside managed runtime data/
      );
    }
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), true);

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.match(purge.stdout, /nothing to purge/);
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
    schemaVersion: 2,
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
    ["link", "--skill", "handoff", "--target", "general"],
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
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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
      runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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
      ["link", "--skill", "review-code", "--target", "general"],
      ["link", "--no-launcher", "--skill", "review-code", "--target", "general"],
      ["link", "--pack", "all", "--target", "general,claude"]
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
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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

test("development link falls back when only a target parent rejects links", async () => {
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
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);
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
    run(["link", "--skill", "handoff", "--target", "general"], fixture.environment);
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
    run(["link", "--skill", "handoff", "--target", "general"], fixture.environment);
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
      () => run(["link", "--skill", "handoff", "--target", "general"], fixture.environment),
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
    run(["link", "--skill", "handoff", "--target", "general"], fixture.environment);
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

test("link validates documented scripts required by active shared skills", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "execute-plan", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "prepare-workspaces.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
      /prepare-workspaces\.mjs is missing or is not a file/
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

test("link validates transitive dependencies of active workflow helpers", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const helper = path.join(fixture.localBin, "adwf-send-and-wake");
    const previousRuntime = fs.realpathSync(current);
    const previousHelper = fs.realpathSync(helper);
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "workflow-lib.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
      /workflow-lib\.mjs is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.realpathSync(helper), previousHelper);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link validates planned workflow helpers before their first publication", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "workflow-lib.mjs"));
    const runCheckout = await checkoutRunner(checkout, fixture.environment);

    assert.throws(
      () => runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]),
      /workflow-lib\.mjs is missing or is not a file/
    );

    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "adwf-send-and-wake")), false);
    assert.equal(pathExists(path.join(fixture.home, ".agents", "skills", "multi-agent-protocol")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link validates transitive dependencies of an active launcher", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const launcher = path.join(fixture.localBin, "agentgear");
    const previousRuntime = fs.realpathSync(current);
    const previousLauncher = fs.realpathSync(launcher);
    fs.rmSync(path.join(checkout, "cli", "lib", "runtime.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
      /cli[\\/]lib[\\/]runtime\.mjs is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.realpathSync(launcher), previousLauncher);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link validates every recorded shared link, including skills outside its selection", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const handoff = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["link", "--pack", "workflow", "--target", "general"]),
      /requires skills[\\/]handoff[\\/]SKILL\.md/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(handoff), true);
    assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), previousState);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link validates commands in documents referenced by active skills", async t => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const activeSkill = path.join(fixture.home, ".agents", "skills", "multi-agent-protocol");
    if (!fs.lstatSync(activeSkill).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "resolve-tool-command.js"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "general"]),
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
      runCheckout(["link", "--skill", "handoff", "--target", "general"]);

      const current = path.join(fixture.dataRoot, "current");
      const launcher = path.join(fixture.localBin, "agentgear");
      const previousRuntime = fs.realpathSync(current);
      const previousState = fs.readFileSync(fixture.stateFile, "utf8");
      fs.rmSync(path.join(checkout, missingPath));

      assert.throws(
        () => runCheckout(["link", "--skill", "handoff", "--target", "general", "--no-launcher"]),
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

test("link ignores a deleted project target retained in installation state", async () => {
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
      "link", "--skill", "handoff", "--target", "general",
      "--scope", "project", "--project", project
    ]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    assert.equal(pathExists(path.join(projectTarget, "handoff")), true);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "general"]);

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.equal(pathExists(projectTarget), false);
    const state = readState(fixture);
    assert.equal(state.targets[projectTarget].skills.handoff.mode, "link");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("link ignores state-recorded skill links pinned to an old physical release", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const target = path.join(fixture.home, ".agents", "skills", "handoff");
    const previousRuntime = fs.realpathSync(current);
    const oldReleaseTarget = fs.realpathSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(oldReleaseTarget, target, process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "general"]);

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(path.join(current, "skills", "handoff", "SKILL.md")), false);
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
    runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]);
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
      () => runCheckout(["link", "--skill", "multi-agent-protocol", "--target", "general"]),
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

test("agentgear-link rejects staged and packaged sources; agentgear has no link command", async () => {
  const fixture = environmentFixture();
  const checkout = path.join(fixture.temporary, "checkout");
  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, fixture.environment);
    runCheckout(["link", "--skill", "handoff", "--target", "general"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    const { main: runtimeLinkMain } = await import(
      `${pathToFileURL(path.join(current, "cli", "link.mjs")).href}?test=${Date.now()}`
    );
    const runRuntimeLink = argumentsList => {
      const original = {};
      for (const [key, value] of Object.entries(fixture.environment)) {
        original[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        runtimeLinkMain(argumentsList);
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    assert.throws(
      () => runRuntimeLink(["--skill", "handoff", "--target", "general"]),
      /agentgear-link must be run from a development checkout/
    );
    assert.equal(fs.realpathSync(current), previousRuntime);

    const packagedSource = path.join(fixture.temporary, "packaged-source");
    fs.cpSync(rootDir, packagedSource, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.rmSync(path.join(packagedSource, ".agentgear-dev-checkout"));
    const { main: packagedLinkMain } = await import(
      `${pathToFileURL(path.join(packagedSource, "cli", "link.mjs")).href}?test=${Date.now()}`
    );
    assert.throws(
      () => invoke(packagedLinkMain, ["--skill", "handoff", "--target", "general"], fixture.environment),
      /agentgear-link must be run from a development checkout/
    );
    assert.throws(
      () => invoke(main, ["link", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Unknown command: link/
    );
    assert.throws(
      () => invoke(main, ["install", "--link", "--skill", "handoff", "--target", "general"], fixture.environment),
      /Unknown option: --link/
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("the published package excludes the developer link command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.bin), ["agentgear"]);
  assert.equal(packageJson.files.includes("bin/agentgear-link.mjs"), false);
  assert.equal(packageJson.files.includes("cli/link.mjs"), false);
  assert.equal(packageJson.scripts.link, undefined);

  const pack = childProcess.spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.equal(pack.status, 0, pack.stderr);
  const files = JSON.parse(pack.stdout)
    .flatMap(entry => entry.files ?? [])
    .map(file => file.path);
  assert.equal(files.includes("bin/agentgear-link.mjs"), false);
  assert.equal(files.includes("cli/link.mjs"), false);
  assert.equal(files.includes("bin/agentgear.mjs"), true);
});

test("link refuses an unrecorded dangling command at the stable current path", t => {
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
      () => run(["link", "--skill", "handoff", "--target", "general"], fixture.environment),
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
    assert.equal(fs.realpathSync(launcher), userLauncher);
    assert.equal(fs.readFileSync(userLauncher, "utf8"), "// user-managed launcher\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
