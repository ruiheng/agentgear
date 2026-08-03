import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../cli/ai-skills.mjs";
import { main as configurePermissions } from "../skills/agent-deck-workflow/scripts/agent-deck-workflow-init-permissions.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function withEnvironment(environment, action) {
  const original = {};
  for (const [key, value] of Object.entries(environment)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("workflow permissions use the stable launcher and never an old source path", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-skills-permissions-test-"));
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  const environment = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    PATH: ""
  };
  try {
    withEnvironment(environment, () => cliMain(["install", "--pack", "workflow", "--target", "codex"]));
    fs.mkdirSync(project, { recursive: true });
    withEnvironment(environment, () => configurePermissions([project]));
    const generated = [
      path.join(project, ".claude", "settings.json"),
      path.join(project, ".codex", "rules", "agent-deck-workflow.rules"),
      path.join(project, ".gemini", "policies", "agent-deck-workflow.toml")
    ].map(filePath => fs.readFileSync(filePath, "utf8"));
    for (const source of generated) {
      assert.match(source, /ai-skills/);
      assert.match(source, /agent-deck-workflow/);
      assert.doesNotMatch(source, /\.config[\\/]ai-agent|\/home\/ruiheng\/config_files/);
      assert.doesNotMatch(source, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const claude = JSON.parse(generated[0]);
    assert.equal(claude.permissions.allow.includes("Bash(~/.local/bin/ai-skills run agent-deck-workflow *)"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
