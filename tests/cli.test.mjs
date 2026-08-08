import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../cli/agentgear.mjs";
import { main as linkMain } from "../cli/link.mjs";
import { directoryFingerprint, stageRuntime, wrapperFingerprint } from "../cli/lib/runtime.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    XDG_STATE_HOME: path.join(temporary, "state")
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

test("canonical fingerprints match fixed golden vectors", () => {
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
      ["link", "--skill", "handoff", "--target", "codex"],
      ["install", "--skill", "handoff", "--target", "codex"]
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
          () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
          errorPattern
        );
        assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
        assert.equal(pathExists(fixture.stateFile), false);
        assert.equal(pathExists(path.join(fixture.home, ".agents", "skills", "handoff")), false);
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
        () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
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
  assert.equal(fs.existsSync(path.join(rootDir, "dist", "codex", ".agents", "skills", "handoff", "SKILL.md")), true);
});

test("release install copies skills, records schema-v2 state, and ordinary uninstall retains the runtime", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--pack", "core", "--target", "codex"], fixture.environment);
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

    // `--skill` alone still selects the default core pack, so this removes
    // every core record from the target; the runtime itself is retained.
    run(["uninstall", "--skill", "handoff", "--target", "codex"], fixture.environment);
    assert.equal(fs.existsSync(skill), false);
    const afterUninstall = readState(fixture);
    assert.deepEqual(afterUninstall.targets, {});
    assert.equal(afterUninstall.channel, "release");
    assert.equal(afterUninstall.releases.length, 1);
    assert.equal(Object.keys(afterUninstall.commands).length, 1);
    assert.equal(pathExists(current), true);
    assert.equal(pathExists(launcher), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("workflow installation provisions its explicit helper commands", t => {
  const fixture = environmentFixture();
  try {
    run(["install", "--pack", "workflow", "--target", "codex"], fixture.environment);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck-workflow", "SKILL.md")), true);
    const state = readState(fixture);
    for (const helper of ["agent-deck-workflow-init-permissions", "adwf-send-and-wake"]) {
      const helperPath = path.join(fixture.localBin, helper);
      if (!fs.lstatSync(helperPath).isSymbolicLink()) {
        t.skip("file links are unavailable on this filesystem");
        return;
      }
      assert.match(fs.readlinkSync(helperPath), /agentgear[\\/]current[\\/]skills[\\/]agent-deck-workflow/);
      assert.equal(state.commands[helperPath].kind, "workflow-helper");
      assert.equal(state.commands[helperPath].mode, "link");
    }
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("developer links target the exact stable current paths", t => {
  const fixture = environmentFixture();
  try {
    run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment);
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

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.readlinkSync(path.dirname(targetSkill)), sharedSkill);
    const editableSource = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.appendFileSync(editableSource, "\n<!-- live-checkout-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.readlinkSync(path.dirname(targetSkill)), sharedSkill);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(path.dirname(targetSkill)), false);

    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);
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
    run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment);
    for (const argumentsList of [
      ["update", "--skill", "handoff", "--target", "codex"],
      ["update", "--force", "--skill", "handoff", "--target", "codex"],
      ["update", "--no-launcher", "--skill", "handoff", "--target", "codex"],
      ["install", "--skill", "handoff", "--target", "codex"]
    ]) {
      assert.throws(
        () => run(argumentsList, fixture.environment),
        /Refusing to switch channel from "development" to "release"/
      );
    }
    fs.rmSync(path.join(fixture.dataRoot, "current"), { force: true });
    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /Refusing to switch channel from "development" to "release"/
    );

    run(["uninstall", "--purge"], fixture.environment);
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
    assert.throws(
      () => run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const commands = [
      [path.join(fixture.localBin, "agentgear"), "launcher"],
      [path.join(fixture.localBin, "agent-deck-workflow-init-permissions"), "workflow-helper"],
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

    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

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

    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);
    const current = path.join(fixture.dataRoot, "current");
    const oldRelease = fs.realpathSync(current);
    fs.rmSync(oldRelease, { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["update", "--skill", "handoff", "--target", "codex"]),
      /Inventoried release is missing or mismatched/
    );
    assert.throws(
      () => runCheckout(["install", "--skill", "handoff", "--target", "codex"]),
      /Inventoried release is missing or mismatched/
    );

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(current), false);
    assert.equal(pathExists(fixture.stateFile), false);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    const developmentCurrent = path.join(fixture.dataRoot, "current");
    const developmentRelease = fs.realpathSync(developmentCurrent);
    fs.rmSync(developmentRelease, { recursive: true, force: true });
    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
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
    run(["install", "--pack", "workflow", "--target", "codex"], fixture.environment);
    fs.mkdirSync(unmanagedSkill, { recursive: true });
    fs.writeFileSync(path.join(unmanagedSkill, "SKILL.md"), "# Keep me\n");
    fs.writeFileSync(path.join(fixture.dataRoot, "user-note.txt"), "keep\n");

    const purge = spawnAgentgear(["uninstall", "--purge"], fixture, fixture.environment);
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(fs.existsSync(path.join(fixture.home, ".agents", "skills", "agent-deck-workflow")), false);
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
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
      () => run(["uninstall", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /Refusing to remove locally changed skill/
    );
    assert.throws(
      () => run(["uninstall", "--force", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
    run(["install", "--skill", "handoff", "--target", "codex,claude"], fixture.environment);
    run(["uninstall", "--purge", "--target", "codex"], fixture.environment);

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
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
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

test("full purge preflights the runtime first and aborts incomplete on a recorded release mismatch", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    fs.rmSync(fixture.stateFile);

    for (const argumentsList of [
      ["install", "--skill", "handoff", "--target", "codex"],
      ["update", "--skill", "handoff", "--target", "codex"],
      ["link", "--skill", "handoff", "--target", "codex"]
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
    run(["install", "--skill", "handoff", "--target", "codex"], environment);
    const skillFile = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const originalContent = fs.readFileSync(skillFile, "utf8");
    const firstCurrent = path.join(firstAlias, "agentgear", "current");

    environment.XDG_DATA_HOME = secondAlias;
    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "codex"], environment),
      /Invalid installation state .*linked command target must be exactly/
    );
    assert.equal(fs.readFileSync(skillFile, "utf8"), originalContent);
    assert.equal(pathExists(firstCurrent), true);

    environment.XDG_DATA_HOME = firstAlias;
    run(["update", "--skill", "handoff", "--target", "codex"], environment);
    assert.equal(pathExists(firstCurrent), true);
    assert.equal(fs.existsSync(skillFile), true);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("whole data root loss fails; full purge then reinstall recovers", () => {
  const fixture = environmentFixture();
  try {
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true });

    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /data root is missing/
    );

    run(["uninstall", "--purge"], fixture.environment);
    assert.equal(fs.existsSync(fixture.stateFile), false);
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
    ["install", "--skill", "handoff", "--target", "codex"],
    ["update", "--skill", "handoff", "--target", "codex"],
    ["link", "--skill", "handoff", "--target", "codex"],
    ["uninstall", "--skill", "handoff", "--target", "codex"],
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
        () => run(["install", "--force", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
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
      runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
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
      ["link", "--skill", "review-code", "--target", "codex"],
      ["link", "--no-launcher", "--skill", "review-code", "--target", "codex"],
      ["link", "--pack", "all", "--target", "codex,claude"]
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
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
    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);

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
    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
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
    run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
    run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
      () => run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
    run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment);
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
    runCheckout(["link", "--skill", "execute-plan", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "prepare-workspaces.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const helper = path.join(fixture.localBin, "adwf-send-and-wake");
    const previousRuntime = fs.realpathSync(current);
    const previousHelper = fs.realpathSync(helper);
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "workflow-lib.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
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
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "workflow-lib.mjs"));
    const runCheckout = await checkoutRunner(checkout, fixture.environment);

    assert.throws(
      () => runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]),
      /workflow-lib\.mjs is missing or is not a file/
    );

    assert.equal(pathExists(path.join(fixture.dataRoot, "current")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "agentgear")), false);
    assert.equal(pathExists(path.join(fixture.localBin, "adwf-send-and-wake")), false);
    assert.equal(pathExists(path.join(fixture.home, ".agents", "skills", "agent-deck-workflow")), false);
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const launcher = path.join(fixture.localBin, "agentgear");
    const previousRuntime = fs.realpathSync(current);
    const previousLauncher = fs.realpathSync(launcher);
    fs.rmSync(path.join(checkout, "cli", "lib", "runtime.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const handoff = path.join(fixture.home, ".agents", "skills", "handoff", "SKILL.md");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(fixture.stateFile, "utf8");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["link", "--pack", "workflow", "--target", "codex"]),
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
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const activeSkill = path.join(fixture.home, ".agents", "skills", "agent-deck-workflow");
    if (!fs.lstatSync(activeSkill).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "resolve-tool-command.js"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
      /resolve-tool-command\.js is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(
      fs.realpathSync(activeSkill),
      path.join(previousRuntime, "skills", "agent-deck-workflow")
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
      runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

      const current = path.join(fixture.dataRoot, "current");
      const launcher = path.join(fixture.localBin, "agentgear");
      const previousRuntime = fs.realpathSync(current);
      const previousState = fs.readFileSync(fixture.stateFile, "utf8");
      fs.rmSync(path.join(checkout, missingPath));

      assert.throws(
        () => runCheckout(["link", "--skill", "handoff", "--target", "codex", "--no-launcher"]),
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
      "link", "--skill", "handoff", "--target", "codex",
      "--scope", "project", "--project", project
    ]);

    const current = path.join(fixture.dataRoot, "current");
    const previousRuntime = fs.realpathSync(current);
    assert.equal(pathExists(path.join(projectTarget, "handoff")), true);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "codex"]);

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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(fixture.dataRoot, "current");
    const target = path.join(fixture.home, ".agents", "skills", "handoff");
    const previousRuntime = fs.realpathSync(current);
    const oldReleaseTarget = fs.realpathSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(oldReleaseTarget, target, process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "codex"]);

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

    runCheckout(["install", "--skill", "handoff", "--target", "codex,claude"]);
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
      () => runCheckout(["install", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);

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
      () => runCheckout(["install", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);

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
      () => runCheckout(["install", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);
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
    fs.appendFileSync(path.join(checkout, "skills", "agent-deck-workflow", "SKILL.md"), "\n<!-- publish-must-not-appear -->\n");
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === current) {
        const error = new Error("simulated publish failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, destination);
    };
    assert.throws(
      () => runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]),
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
    runCheckout(["install", "--skill", "handoff", "--target", "codex"]);
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
      () => runCheckout(["install", "--skill", "handoff", "--target", "codex"]),
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
      () => runCheckout(["update", "--skill", "handoff", "--target", "codex"]),
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
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

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
      () => runRuntimeLink(["--skill", "handoff", "--target", "codex"]),
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
      () => invoke(packagedLinkMain, ["--skill", "handoff", "--target", "codex"], fixture.environment),
      /agentgear-link must be run from a development checkout/
    );
    assert.throws(
      () => invoke(main, ["link", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /Unknown command: link/
    );
    assert.throws(
      () => invoke(main, ["install", "--link", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
      () => run(["link", "--skill", "handoff", "--target", "codex"], fixture.environment),
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
    run(["install", "--skill", "handoff", "--target", "codex"], fixture.environment);
    const current = path.join(fixture.dataRoot, "current");
    fs.rmSync(current, { force: true });
    const userLauncher = path.join(current, "bin", "agentgear.mjs");
    fs.mkdirSync(path.dirname(userLauncher), { recursive: true });
    fs.writeFileSync(userLauncher, "// user-managed launcher\n");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.rmSync(launcher, { force: true });
    fs.symlinkSync(userLauncher, launcher);

    assert.throws(
      () => run(["update", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /Refusing to replace unmanaged runtime path/
    );
    assert.throws(
      () => run(["install", "--force", "--skill", "handoff", "--target", "codex"], fixture.environment),
      /Refusing to replace unmanaged runtime path/
    );
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(launcher), userLauncher);
    assert.equal(fs.readFileSync(userLauncher, "utf8"), "// user-managed launcher\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
