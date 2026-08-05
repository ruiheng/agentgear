import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../cli/agentgear.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathExists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function run(argumentsList, env = {}) {
  const original = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    main(argumentsList);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

    run(["uninstall", "--purge", "--dry-run"], environment);
    assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "agent-deck-workflow")), true);
    assert.equal(fs.existsSync(path.join(localBin, "agentgear")), true);
    assert.equal(fs.existsSync(path.join(dataRoot, "current")), true);

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

test("developer links stay live while release installs become independent copies", () => {
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
    assert.equal(fs.realpathSync(targetSkill), path.join(rootDir, "skills", "handoff"));

    run(["update", "--pack", "core", "--target", "codex"], environment);
    assert.equal(fs.lstatSync(targetSkill).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(targetSkill, "SKILL.md")), true);
    assert.notEqual(fs.realpathSync(targetSkill), path.join(rootDir, "skills", "handoff"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a developer checkout applies edits live, then update freezes that exact revision", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-live-update-test-"));
  const checkout = path.join(temporary, "checkout");
  const home = path.join(temporary, "home");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state")
  };
  const targetSkill = path.join(home, ".agents", "skills", "handoff", "SKILL.md");

  try {
    fs.cpSync(rootDir, checkout, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const { main: checkoutMain } = await import(`${pathToFileURL(path.join(checkout, "cli", "agentgear.mjs")).href}?test=${Date.now()}`);
    const runCheckout = argumentsList => {
      const original = {};
      for (const [key, value] of Object.entries(environment)) {
        original[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        checkoutMain(argumentsList);
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    runCheckout(["link", "--skill", "handoff", "--target", "codex"]);
    const editableSource = path.join(checkout, "skills", "handoff", "SKILL.md");
    fs.appendFileSync(editableSource, "\n<!-- live-checkout-marker -->\n");
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);

    runCheckout(["update", "--skill", "handoff", "--target", "codex"]);
    assert.equal(fs.lstatSync(path.dirname(targetSkill)).isSymbolicLink(), false);
    assert.match(fs.readFileSync(targetSkill, "utf8"), /live-checkout-marker/);
    fs.appendFileSync(editableSource, "\n<!-- post-update-marker -->\n");
    assert.doesNotMatch(fs.readFileSync(targetSkill, "utf8"), /post-update-marker/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
