import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../cli/agentgear.mjs";
import { main as linkMain } from "../cli/link.mjs";
import { stageRuntime } from "../cli/lib/runtime.mjs";

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

test("lists the catalog and builds every target layout", () => {
  run(["build"]);
  assert.equal(fs.existsSync(path.join(rootDir, "dist", "codex", ".agents", "skills", "handoff", "SKILL.md")), true);
});

test("installs, launches, and safely uninstalls a managed core skill", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-cli-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    run(["install", "--pack", "core", "--target", "codex"], environment);
    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "handoff", "SKILL.md")), true);

    const launcher = path.join(home, ".local", "bin", "agentgear");
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(fs.existsSync(fs.realpathSync(launcher)), true);

    run(["uninstall", "--skill", "handoff", "--target", "codex"], environment);
    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "handoff")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow installation provisions its explicit helper commands", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-workflow-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    run(["install", "--pack", "workflow", "--target", "codex"], environment);
    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "agent-deck-workflow", "SKILL.md")), true);
    for (const helper of ["agent-deck-workflow-init-permissions", "adwf-send-and-wake"]) {
      const helperPath = path.join(home, ".local", "bin", helper);
      assert.equal(fs.lstatSync(helperPath).isSymbolicLink(), true);
      assert.match(fs.readlinkSync(helperPath), /agentgear[\\/]current[\\/]skills[\\/]agent-deck-workflow/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("purge removes managed skills and runtime artifacts but preserves unowned files", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-purge-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(environment.XDG_DATA_HOME, "agentgear");
  const localBin = path.join(home, ".local", "bin");
  const unmanagedSkill = path.join(home, ".agents", "skills", "not-managed-by-agentgear");

  try {
    run(["install", "--pack", "workflow", "--target", "codex"], environment);
    fs.mkdirSync(unmanagedSkill, { recursive: true });
    fs.writeFileSync(path.join(unmanagedSkill, "SKILL.md"), "# Keep me\n");
    fs.writeFileSync(path.join(dataRoot, "user-note.txt"), "keep\n");

    const purge = childProcess.spawnSync(process.execPath, [path.join(localBin, "agentgear"), "uninstall", "--purge"], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "agent-deck-workflow")), false);
    assert.equal(fs.existsSync(unmanagedSkill), true);
    assert.equal(pathExists(path.join(localBin, "agentgear")), false);
    assert.equal(pathExists(path.join(localBin, "agent-deck-workflow-init-permissions")), false);
    assert.equal(pathExists(path.join(localBin, "adwf-send-and-wake")), false);
    assert.equal(pathExists(path.join(dataRoot, "current")), false);
    assert.equal(fs.existsSync(path.join(dataRoot, "releases")), false);
    assert.equal(fs.existsSync(path.join(dataRoot, "user-note.txt")), true);
    assert.equal(fs.existsSync(path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("purge refuses locally changed skills until forced", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-purge-safety-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const skillFile = path.join(home, ".agents", "skills", "handoff", "SKILL.md");
  const launcher = path.join(home, ".local", "bin", "agentgear");

  try {
    run(["install", "--skill", "handoff", "--target", "codex"], environment);
    fs.appendFileSync(skillFile, "\nLocal change\n");

    assert.throws(
      () => run(["uninstall", "--purge"], environment),
      /Refusing to remove locally changed skill/
    );
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(fs.existsSync(launcher), true);

    run(["uninstall", "--purge", "--force"], environment);
    assert.equal(fs.existsSync(skillFile), false);
    assert.equal(fs.existsSync(launcher), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("targeted purge retains shared runtime while another target remains managed", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-targeted-purge-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(environment.XDG_DATA_HOME, "agentgear");
  const launcher = path.join(home, ".local", "bin", "agentgear");

  try {
    run(["install", "--skill", "handoff", "--target", "codex,claude"], environment);
    run(["uninstall", "--purge", "--target", "codex"], environment);

    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "handoff")), false);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "handoff")), true);
    assert.equal(pathExists(launcher), true);
    assert.equal(pathExists(path.join(dataRoot, "current")), true);
    assert.equal(fs.existsSync(path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json")), true);

    run(["uninstall", "--purge"], environment);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "handoff")), false);
    assert.equal(pathExists(launcher), false);
    assert.equal(pathExists(path.join(dataRoot, "current")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("developer links target the shared runtime while release installs become independent copies", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-channel-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const targetSkill = path.join(home, ".agents", "skills", "handoff");

  try {
    run(["link", "--pack", "core", "--target", "codex"], environment);
    assert.equal(fs.lstatSync(targetSkill).isSymbolicLink(), true);
    assert.equal(
      fs.readlinkSync(targetSkill),
      path.join(environment.XDG_DATA_HOME, "agentgear", "current", "skills", "handoff")
    );
    assert.notEqual(fs.realpathSync(targetSkill), path.join(rootDir, "skills", "handoff"));

    run(["update", "--pack", "core", "--target", "codex"], environment);
    assert.equal(fs.lstatSync(targetSkill).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(targetSkill, "SKILL.md")), true);
    assert.notEqual(fs.realpathSync(targetSkill), path.join(rootDir, "skills", "handoff"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a shared runtime remains managed through a symlinked XDG data directory", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-xdg-data-alias-test-"));
  const home = path.join(temporary, "home");
  const physicalDataHome = path.join(temporary, "physical-data");
  const dataHomeAlias = path.join(temporary, "data-alias");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: dataHomeAlias,
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(dataHomeAlias, "agentgear");

  try {
    fs.mkdirSync(physicalDataHome, { recursive: true });
    fs.symlinkSync(
      physicalDataHome,
      dataHomeAlias,
      process.platform === "win32" ? "junction" : "dir"
    );

    run(["link", "--skill", "handoff", "--target", "codex"], environment);
    run(["link", "--skill", "handoff", "--target", "codex"], environment);
    run(["update", "--skill", "handoff", "--target", "codex"], environment);
    run(["uninstall", "--purge"], environment);

    assert.equal(pathExists(path.join(dataRoot, "current")), false);
    assert.equal(pathExists(path.join(dataRoot, "releases")), false);
    assert.equal(pathExists(path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link recovers a dangling managed runtime and launcher", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-dangling-launcher-recovery-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const launcher = path.join(home, ".local", "bin", "agentgear");
    const oldRelease = fs.realpathSync(current);
    fs.rmSync(oldRelease, { recursive: true, force: true });
    assert.equal(pathExists(current), true);
    assert.equal(fs.existsSync(launcher), false);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    assert.equal(fs.existsSync(current), true);
    assert.notEqual(fs.realpathSync(current), oldRelease);
    assert.equal(fs.existsSync(launcher), true);
    assert.equal(
      fs.realpathSync(launcher),
      path.join(fs.realpathSync(current), "bin", "agentgear.mjs")
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link restores a removed current link and its recorded command links", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-missing-current-recovery-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const localBin = path.join(home, ".local", "bin");
    const commands = [
      [path.join(localBin, "agentgear"), "launcher"],
      [path.join(localBin, "agent-deck-workflow-init-permissions"), "workflow helper"],
      [path.join(localBin, "adwf-send-and-wake"), "workflow helper"]
    ];
    if (commands.some(([command]) => !fs.lstatSync(command).isSymbolicLink())) {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    const oldRelease = fs.realpathSync(current);
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const [command, kind] of commands) {
      assert.equal(state.commands[command].kind, kind);
      assert.equal(state.commands[command].mode, "link");
    }

    fs.rmSync(current, { recursive: true, force: true });
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
      fs.realpathSync(path.join(localBin, "agentgear")),
      path.join(fs.realpathSync(current), "bin", "agentgear.mjs")
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link refuses an unrecorded dangling command at the stable current path", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-unrecorded-dangling-command-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(environment.XDG_DATA_HOME, "agentgear");
  const launcher = path.join(home, ".local", "bin", "agentgear");
  const expectedTarget = path.join(dataRoot, "current", "bin", "agentgear.mjs");

  try {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    try {
      fs.symlinkSync(expectedTarget, launcher, "file");
    } catch {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    assert.throws(
      () => run(["link", "--skill", "handoff", "--target", "codex"], environment),
      /Refusing to replace unmanaged launcher/
    );
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(pathExists(path.join(dataRoot, "current")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("purge removes recorded dangling command links after current is removed", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-missing-current-purge-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const launcher = path.join(home, ".local", "bin", "agentgear");
    if (!fs.lstatSync(launcher).isSymbolicLink()) {
      t.skip("file links are unavailable on this filesystem");
      return;
    }
    fs.rmSync(current, { recursive: true, force: true });

    runCheckout(["uninstall", "--purge"]);

    assert.equal(pathExists(launcher), false);
    assert.equal(pathExists(path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates stable skill links through equivalent XDG data aliases", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-xdg-alias-consumer-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const physicalDataHome = path.join(temporary, "physical-data");
  const firstAlias = path.join(temporary, "data-first");
  const secondAlias = path.join(temporary, "data-second");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: firstAlias,
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.mkdirSync(physicalDataHome, { recursive: true });
    for (const alias of [firstAlias, secondAlias]) {
      fs.symlinkSync(
        physicalDataHome,
        alias,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(firstAlias, "agentgear", "current");
    const target = path.join(home, ".agents", "skills", "handoff");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(stateFile, "utf8");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });
    environment.XDG_DATA_HOME = secondAlias;

    assert.throws(
      () => runCheckout(["link", "--pack", "workflow", "--target", "codex"]),
      /requires skills[\\/]handoff[\\/]SKILL\.md/
    );

    assert.equal(fs.realpathSync(path.join(secondAlias, "agentgear", "current")), previousRuntime);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link recovers a dangling managed runtime through an equivalent XDG alias", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-xdg-dangling-recovery-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const physicalDataHome = path.join(temporary, "physical-data");
  const firstAlias = path.join(temporary, "data-first");
  const secondAlias = path.join(temporary, "data-second");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: firstAlias,
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.mkdirSync(physicalDataHome, { recursive: true });
    for (const alias of [firstAlias, secondAlias]) {
      fs.symlinkSync(
        physicalDataHome,
        alias,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(firstAlias, "agentgear", "current");
    const oldRelease = fs.realpathSync(current);
    const launcher = path.join(home, ".local", "bin", "agentgear");
    fs.rmSync(oldRelease, { recursive: true, force: true });
    environment.XDG_DATA_HOME = secondAlias;

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const recoveredCurrent = path.join(secondAlias, "agentgear", "current");
    assert.equal(fs.existsSync(recoveredCurrent), true);
    assert.notEqual(fs.realpathSync(recoveredCurrent), oldRelease);
    assert.equal(fs.existsSync(launcher), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates shared runtime wrappers through equivalent XDG aliases", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-xdg-wrapper-alias-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const physicalDataHome = path.join(temporary, "physical-data");
  const firstAlias = path.join(temporary, "data-first");
  const secondAlias = path.join(temporary, "data-second");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: firstAlias,
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalSymlink = fs.symlinkSync;

  try {
    fs.mkdirSync(physicalDataHome, { recursive: true });
    for (const alias of [firstAlias, secondAlias]) {
      fs.symlinkSync(
        physicalDataHome,
        alias,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    const localBin = path.join(home, ".local", "bin");
    fs.symlinkSync = (target, destination, type) => {
      if (path.dirname(path.resolve(destination)) === localBin) {
        const error = new Error("simulated file-link denial");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    fs.symlinkSync = originalSymlink;

    const current = path.join(firstAlias, "agentgear", "current");
    const launcher = path.join(localBin, "agentgear");
    const previousRuntime = fs.realpathSync(current);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    fs.rmSync(path.join(checkout, "bin", "agentgear.mjs"));
    environment.XDG_DATA_HOME = secondAlias;

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex", "--no-launcher"]),
      /requires bin[\\/]agentgear\.mjs/
    );

    assert.equal(fs.realpathSync(path.join(secondAlias, "agentgear", "current")), previousRuntime);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fallback refuses a launcher that belongs to an unmanaged current directory", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-unmanaged-current-launcher-test-"));
  const home = path.join(temporary, "home");
  const dataHome = path.join(temporary, "data");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(dataHome, "agentgear");
  const userLauncher = path.join(dataRoot, "current", "bin", "agentgear.mjs");
  const launcher = path.join(home, ".local", "bin", "agentgear");
  const originalSymlink = fs.symlinkSync;

  try {
    fs.mkdirSync(path.dirname(userLauncher), { recursive: true });
    fs.writeFileSync(userLauncher, "// user-managed launcher\n");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.symlinkSync(userLauncher, launcher);
    fs.symlinkSync = (target, destination, type) => {
      if (
        path.dirname(path.resolve(destination)) === dataRoot
        && path.basename(destination).includes("runtime-link-probe")
      ) {
        const error = new Error("simulated directory-link denial");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };

    assert.throws(
      () => run(["link", "--skill", "handoff", "--target", "codex"], environment),
      /Refusing to replace unmanaged launcher/
    );
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(launcher), userLauncher);
    assert.equal(fs.readFileSync(userLauncher, "utf8"), "// user-managed launcher\n");
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link restores a managed skill link to the stable current path", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-stable-link-test-"));
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalNow = Date.now;
  let now = 1000;

  try {
    Date.now = () => ++now;
    run(["link", "--skill", "handoff", "--target", "codex"], environment);
    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const target = path.join(home, ".agents", "skills", "handoff");
    const oldReleaseTarget = fs.realpathSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(
      oldReleaseTarget,
      target,
      process.platform === "win32" ? "junction" : "dir"
    );

    run(["link", "--skill", "handoff", "--target", "codex"], environment);

    const stableTarget = path.join(current, "skills", "handoff");
    assert.notEqual(fs.realpathSync(target), oldReleaseTarget);
    assert.equal(fs.realpathSync(target), fs.realpathSync(stableTarget));
    if (process.platform !== "win32") {
      assert.equal(fs.readlinkSync(target), stableTarget);
    }
  } finally {
    Date.now = originalNow;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime stages use distinct release IDs in one clock tick", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-runtime-id-test-"));
  const environment = {
    HOME: path.join(temporary, "home"),
    XDG_DATA_HOME: path.join(temporary, "data")
  };
  const originalNow = Date.now;

  try {
    Date.now = () => 12345;
    const first = stageRuntime({ sourceRoot: rootDir, env: environment });
    const second = stageRuntime({ sourceRoot: rootDir, env: environment });

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.root, second.root);
    assert.equal(fs.existsSync(first.root), true);
    assert.equal(fs.existsSync(second.root), true);
  } finally {
    Date.now = originalNow;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rerunning link refreshes shared developer links, then update freezes that revision", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-live-update-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const targetSkill = path.join(home, ".agents", "skills", "handoff", "SKILL.md");
  const targetSkillDirectory = path.dirname(targetSkill);
  const sharedSkill = path.join(environment.XDG_DATA_HOME, "agentgear", "current", "skills", "handoff");

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.readlinkSync(targetSkillDirectory), sharedSkill);
    const editableSource = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.appendFileSync(editableSource, "\n<!-- live-checkout-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.readlinkSync(targetSkillDirectory), sharedSkill);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);
    fs.appendFileSync(editableSource, "\n<!-- post-link-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /post-link-marker/);

    runCheckout(["update", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.lstatSync(path.dirname(targetSkill)).isSymbolicLink(), false);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /post-link-marker/);
    fs.appendFileSync(editableSource, "\n<!-- post-update-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /post-update-marker/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("agentgear-link rejects staged and packaged sources; agentgear has no link command", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-link-source-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const previousRuntime = fs.realpathSync(current);
    const { main: runtimeLinkMain } = await import(
      `${pathToFileURL(path.join(current, "cli", "link.mjs")).href}?test=${Date.now()}`
    );
    const runRuntimeLink = argumentsList => {
      const original = {};
      for (const [key, value] of Object.entries(environment)) {
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

    const packagedSource = path.join(temporary, "packaged-source");
    fs.cpSync(rootDir, packagedSource, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.rmSync(path.join(packagedSource, ".agentgear-dev-checkout"));
    const { main: packagedLinkMain } = await import(
      `${pathToFileURL(path.join(packagedSource, "cli", "link.mjs")).href}?test=${Date.now()}`
    );
    assert.throws(
      () => invoke(packagedLinkMain, ["--skill", "handoff", "--target", "codex"], environment),
      /agentgear-link must be run from a development checkout/
    );
    assert.throws(
      () => invoke(main, ["link", "--skill", "handoff", "--target", "codex"], environment),
      /Unknown command: link/
    );
    assert.throws(
      () => invoke(main, ["install", "--link", "--skill", "handoff", "--target", "codex"], environment),
      /Unknown option: --link/
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("failed link keeps the previously published shared runtime active", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-failed-link-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const targetSkill = path.join(home, ".agents", "skills", "handoff", "SKILL.md");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(stateFile, "utf8");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- must-not-publish -->\n");

    const launcher = path.join(home, ".local", "bin", "agentgear");
    fs.rmSync(launcher, { force: true });
    fs.writeFileSync(launcher, "user-managed launcher\n");
    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
      /Refusing to replace unmanaged launcher/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /must-not-publish/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed target write keeps existing shared links on the previous runtime", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-failed-target-write-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalCopy = fs.cpSync;

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);

    runCheckout(["link", "--skill", "handoff", "--target", "codex,claude"]);
    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const codexSkill = path.join(home, ".agents", "skills", "handoff");
    const claudeSkill = path.join(home, ".claude", "skills", "handoff", "SKILL.md");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(stateFile, "utf8");
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
      () => runCheckout(["update", "--skill", "handoff", "--target", "codex"]),
      /simulated target write failure/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.doesNotMatch(fs.readFileSync(claudeSkill, "utf8"), /target-write-must-not-publish/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates every recorded shared link, including skills outside its selection", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-unselected-shared-link-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const handoff = path.join(home, ".agents", "skills", "handoff", "SKILL.md");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    const previousState = fs.readFileSync(stateFile, "utf8");
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    assert.throws(
      () => runCheckout(["link", "--pack", "workflow", "--target", "codex"]),
      /requires skills[\\/]handoff[\\/]SKILL\.md/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(handoff), true);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link ignores a deleted project target retained in installation state", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-stale-project-target-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const projectTarget = path.join(project, ".agents", "skills");

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    fs.mkdirSync(project, { recursive: true });
    runCheckout([
      "link", "--skill", "handoff", "--target", "codex",
      "--scope", "project", "--project", project
    ]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    assert.equal(pathExists(path.join(projectTarget, "handoff")), true);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "codex"]);

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.equal(pathExists(projectTarget), false);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.targets[projectTarget].skills.handoff.mode, "link");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link ignores state-recorded skill links pinned to an old physical release", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-physical-skill-link-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const target = path.join(home, ".agents", "skills", "handoff");
    const previousRuntime = fs.realpathSync(current);
    const oldReleaseTarget = fs.realpathSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(
      oldReleaseTarget,
      target,
      process.platform === "win32" ? "junction" : "dir"
    );
    fs.rmSync(path.join(checkout, "skills", "handoff"), { recursive: true, force: true });

    runCheckout(["link", "--pack", "workflow", "--target", "codex"]);

    assert.notEqual(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.existsSync(path.join(current, "skills", "handoff", "SKILL.md")), false);
    assert.equal(fs.realpathSync(target), oldReleaseTarget);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link with --no-launcher preserves launchers whose next runtime is incomplete", async () => {
  for (const [missingPath, errorPattern] of [
    [path.join("bin", "agentgear.mjs"), /requires bin[\\/]agentgear\.mjs/],
    [path.join("cli", "agentgear.mjs"), /cli[\\/]agentgear\.mjs is missing or is not a file/]
  ]) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-launcher-entrypoint-test-"));
    const checkout = path.join(temporary, "checkout");
    const home = path.join(temporary, "home");
    const environment = {
      HOME: home,
      XDG_DATA_HOME: path.join(temporary, "data"),
      XDG_STATE_HOME: path.join(temporary, "state")
    };

    try {
      fs.cpSync(rootDir, checkout, {
        recursive: true,
        filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
      });
      const runCheckout = await checkoutRunner(checkout, environment);
      runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

      const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
      const launcher = path.join(home, ".local", "bin", "agentgear");
      const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
      const previousRuntime = fs.realpathSync(current);
      const previousState = fs.readFileSync(stateFile, "utf8");
      fs.rmSync(path.join(checkout, missingPath));

      assert.throws(
        () => runCheckout(["link", "--skill", "handoff", "--target", "codex", "--no-launcher"]),
        errorPattern
      );

      assert.equal(fs.realpathSync(current), previousRuntime);
      assert.equal(fs.existsSync(launcher), true);
      assert.equal(fs.realpathSync(launcher), path.join(previousRuntime, "bin", "agentgear.mjs"));
      assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("link validates transitive dependencies of active workflow helpers", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-helper-dependency-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const helper = path.join(home, ".local", "bin", "adwf-send-and-wake");
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
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates planned workflow helpers before their first publication", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-planned-helper-dependency-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "workflow-lib.mjs"));
    const runCheckout = await checkoutRunner(checkout, environment);

    assert.throws(
      () => runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]),
      /workflow-lib\.mjs is missing or is not a file/
    );

    assert.equal(pathExists(path.join(environment.XDG_DATA_HOME, "agentgear", "current")), false);
    assert.equal(pathExists(path.join(home, ".local", "bin", "agentgear")), false);
    assert.equal(pathExists(path.join(home, ".local", "bin", "adwf-send-and-wake")), false);
    assert.equal(pathExists(path.join(home, ".agents", "skills", "agent-deck-workflow")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates transitive dependencies of an active launcher", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-launcher-dependency-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const launcher = path.join(home, ".local", "bin", "agentgear");
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
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a launcher write failure restores copied skills that were already replaced", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-launcher-rollback-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalSymlink = fs.symlinkSync;

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["update", "--skill", "handoff", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const targetSkill = path.join(home, ".agents", "skills", "handoff", "SKILL.md");
    const launcher = path.join(home, ".local", "bin", "agentgear");
    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    const previousRuntime = fs.realpathSync(current);
    const previousSkill = fs.readFileSync(targetSkill, "utf8");
    const previousState = fs.readFileSync(stateFile, "utf8");
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
      () => runCheckout(["update", "--skill", "handoff", "--target", "codex"]),
      /simulated launcher write failure/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(fs.readFileSync(targetSkill, "utf8"), previousSkill);
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /launcher-rollback-marker/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previousState);
    assert.equal(fs.existsSync(launcher), true);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("ESM fallback wrappers stay on current when publication fails", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-wrapper-current-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalSymlink = fs.symlinkSync;
  const originalRename = fs.renameSync;

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "package.json"), '{"type":"module"}\n');
    const runCheckout = await checkoutRunner(checkout, environment);
    const localBin = path.join(home, ".local", "bin");
    const launcher = path.join(localBin, "agentgear");
    const helpers = [
      "agent-deck-workflow-init-permissions",
      "adwf-send-and-wake"
    ];
    fs.symlinkSync = (target, destination, type) => {
      if (path.dirname(path.resolve(destination)) === localBin) {
        const error = new Error("file links unavailable");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const launcherSource = fs.readFileSync(launcher, "utf8");
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    assert.match(launcherSource, /agentgear-managed-runtime-shim/);
    assert.equal(launcherSource.includes(JSON.stringify(path.join(current, "bin", "agentgear.mjs"))), true);
    assert.doesNotMatch(launcherSource, /require\s*\(/);
    for (const [name, script] of [
      ["agent-deck-workflow-init-permissions", "agent-deck-workflow-init-permissions.mjs"],
      ["adwf-send-and-wake", "adwf-send-and-wake.mjs"]
    ]) {
      const helperSource = fs.readFileSync(path.join(localBin, name), "utf8");
      assert.equal(
        helperSource.includes(JSON.stringify(path.join(current, "skills", "agent-deck-workflow", "scripts", script))),
        true
      );
    }
    const launched = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(launched.status, 0, launched.stderr);

    const checkoutCli = path.join(checkout, "cli", "agentgear.mjs");
    const changedCli = fs.readFileSync(checkoutCli, "utf8").replace('print("Packs:");', 'print("unpublished-runtime-marker");');
    fs.writeFileSync(checkoutCli, changedCli);
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

    const afterFailure = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(afterFailure.status, 0, afterFailure.stderr);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(launcher, "utf8"), launcherSource);
    for (const helper of helpers) assert.equal(fs.lstatSync(path.join(localBin, helper)).isSymbolicLink(), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.renameSync = originalRename;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link falls back to copied skills when the filesystem rejects links", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-link-fallback-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalSymlink = fs.symlinkSync;

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    fs.symlinkSync = () => {
      const error = new Error("links unavailable");
      error.code = "EPERM";
      throw error;
    };
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);

    const skill = path.join(home, ".agents", "skills", "handoff");
    const launcher = path.join(home, ".local", "bin", "agentgear");
    const state = JSON.parse(fs.readFileSync(path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json"), "utf8"));
    const targetState = state.targets[path.join(home, ".agents", "skills")];
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
    assert.match(fs.readFileSync(launcher, "utf8"), /agentgear-managed-runtime-shim/);
    assert.equal(targetState.skills.handoff.mode, "copy");
    const launched = childProcess.spawnSync(process.execPath, [launcher, "list"], {
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(launched.status, 0, launched.stderr);
    const rejected = childProcess.spawnSync(process.execPath, [launcher, "run", "handoff", "missing.mjs"], {
      encoding: "utf8",
      env: { ...process.env, ...environment }
    });
    assert.equal(rejected.status, 1);

    const targetSkill = path.join(skill, "SKILL.md");
    fs.appendFileSync(path.join(checkout, "skills", "handoff", "SKILL.md"), "\n<!-- copied-link-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /copied-link-marker/);
    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /copied-link-marker/);

    runCheckout(["uninstall", "--purge"]);
    assert.equal(pathExists(skill), false);
    assert.equal(pathExists(launcher), false);
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("update migrates verified legacy development command links", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-legacy-command-migration-test-"));
  const legacyCheckout = path.join(temporary, "legacy-checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const targetRoot = path.join(home, ".agents", "skills");
  const localBin = path.join(home, ".local", "bin");
  const launcher = path.join(localBin, "agentgear");
  const helpers = [
    ["agent-deck-workflow-init-permissions", "agent-deck-workflow-init-permissions.mjs"],
    ["adwf-send-and-wake", "adwf-send-and-wake.mjs"]
  ];

  try {
    fs.cpSync(rootDir, legacyCheckout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const legacySkill = path.join(legacyCheckout, "skills", "agent-deck-workflow");
    const targetSkill = path.join(targetRoot, "agent-deck-workflow");
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.mkdirSync(localBin, { recursive: true });
    try {
      fs.symlinkSync(legacySkill, targetSkill, process.platform === "win32" ? "junction" : "dir");
      fs.symlinkSync(path.join(legacyCheckout, "bin", "agentgear.mjs"), launcher, "file");
      for (const [name, script] of helpers) {
        fs.symlinkSync(
          path.join(legacyCheckout, "skills", "agent-deck-workflow", "scripts", script),
          path.join(localBin, name),
          "file"
        );
      }
    } catch {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    const stateFile = path.join(environment.XDG_STATE_HOME, "agentgear", "installs.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({
      schemaVersion: 1,
      targets: {
        [targetRoot]: {
          skills: {
            "agent-deck-workflow": {
              source: fs.realpathSync(legacySkill),
              mode: "link",
              fingerprint: null,
              runtimeId: `link:${legacyCheckout}`,
              installedAt: new Date().toISOString()
            }
          }
        }
      }
    }, null, 2)}\n`);

    run(["update", "--skill", "agent-deck-workflow", "--target", "codex"], environment);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    assert.equal(
      fs.realpathSync(launcher),
      path.join(fs.realpathSync(current), "bin", "agentgear.mjs")
    );
    for (const [name, script] of helpers) {
      assert.equal(
        fs.realpathSync(path.join(localBin, name)),
        path.join(fs.realpathSync(current), "skills", "agent-deck-workflow", "scripts", script)
      );
    }
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.commands[launcher].kind, "launcher");
    for (const [name] of helpers) {
      assert.equal(state.commands[path.join(localBin, name)].kind, "workflow helper");
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates documented scripts required by active shared skills", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-active-skill-payload-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "execute-plan", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const previousRuntime = fs.realpathSync(current);
    fs.rmSync(path.join(checkout, "skills", "agent-deck-workflow", "scripts", "prepare-workspaces.mjs"));

    assert.throws(
      () => runCheckout(["link", "--skill", "handoff", "--target", "codex"]),
      /prepare-workspaces\.mjs is missing or is not a file/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(
      fs.realpathSync(path.join(home, ".agents", "skills", "execute-plan")),
      path.join(previousRuntime, "skills", "execute-plan")
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("purge preserves an unrecorded launcher into an unmanaged current directory", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-unmanaged-current-purge-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const dataRoot = path.join(environment.XDG_DATA_HOME, "agentgear");
  const current = path.join(dataRoot, "current");
  const launcher = path.join(home, ".local", "bin", "agentgear");

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "handoff", "--target", "codex", "--no-launcher"]);

    fs.rmSync(current, { recursive: true, force: true });
    const userLauncher = path.join(current, "bin", "agentgear.mjs");
    fs.mkdirSync(path.dirname(userLauncher), { recursive: true });
    fs.writeFileSync(userLauncher, "// user-managed launcher\n");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    try {
      fs.symlinkSync(userLauncher, launcher, "file");
    } catch {
      t.skip("file links are unavailable on this filesystem");
      return;
    }

    runCheckout(["uninstall", "--purge"]);

    assert.equal(pathExists(launcher), true);
    assert.equal(fs.realpathSync(launcher), userLauncher);
    assert.equal(fs.readFileSync(userLauncher, "utf8"), "// user-managed launcher\n");
    assert.equal(pathExists(current), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link refuses copy fallback while shared runtime consumers remain", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-shared-fallback-safety-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const originalSymlink = fs.symlinkSync;

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "execute-plan", "--target", "codex"]);

    const dataRoot = path.join(environment.XDG_DATA_HOME, "agentgear");
    const current = path.join(dataRoot, "current");
    const activeSkill = path.join(home, ".agents", "skills", "execute-plan");
    const launcher = path.join(home, ".local", "bin", "agentgear");
    if (!fs.lstatSync(activeSkill).isSymbolicLink()) {
      t.skip("directory links are unavailable on this filesystem");
      return;
    }
    const previousRuntime = fs.realpathSync(current);
    const launcherWasLink = fs.lstatSync(launcher).isSymbolicLink();
    const previousLauncher = launcherWasLink
      ? fs.readlinkSync(launcher)
      : fs.readFileSync(launcher, "utf8");

    fs.symlinkSync = (target, destination, type) => {
      const normalizedDestination = path.resolve(destination);
      if (
        path.dirname(normalizedDestination) === dataRoot
        && path.basename(normalizedDestination).startsWith(".runtime-link-probe.")
      ) {
        const error = new Error("directory links unavailable");
        error.code = "EPERM";
        throw error;
      }
      return originalSymlink(target, destination, type);
    };

    assert.throws(
      () => runCheckout(["link", "--skill", "review-code", "--target", "codex"]),
      /Cannot use copy fallback while shared runtime consumers remain/
    );

    assert.equal(fs.realpathSync(current), previousRuntime);
    assert.equal(pathExists(path.join(home, ".agents", "skills", "review-code")), false);
    assert.equal(fs.lstatSync(launcher).isSymbolicLink(), launcherWasLink);
    assert.equal(
      launcherWasLink ? fs.readlinkSync(launcher) : fs.readFileSync(launcher, "utf8"),
      previousLauncher
    );
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("link validates commands in documents referenced by active skills", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-reference-payload-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const runCheckout = await checkoutRunner(checkout, environment);
    runCheckout(["link", "--skill", "agent-deck-workflow", "--target", "codex"]);

    const current = path.join(environment.XDG_DATA_HOME, "agentgear", "current");
    const activeSkill = path.join(home, ".agents", "skills", "agent-deck-workflow");
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
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
