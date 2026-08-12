import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveSelection } from "../cli/lib/catalog.mjs";
import { LEGACY_SKILL_NAMES, migrateLegacySkills } from "../cli/lib/legacy-skill-migration.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrySkills = [
  "assess-tech-design",
  "check-waypost-messages",
  "code-health-review",
  "commit-staged",
  "delegate-task",
  "dispatch-plan",
  "explain-for-me",
  "explore-defects",
  "fix-strategy",
  "handoff",
  "refactor-review",
  "roundtable",
  "simplify-review",
  "tech-design-workflow"
];

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-disclosure-test-"));
  return {
    temporary,
    env: {
      HOME: path.join(temporary, "home"),
      XDG_DATA_HOME: path.join(temporary, "data"),
      XDG_STATE_HOME: path.join(temporary, "state"),
      PATH: process.env.PATH
    }
  };
}

function command(argumentsList, env = {}) {
  return childProcess.spawnSync(process.execPath, [path.join(rootDir, "bin", "agentgear.mjs"), ...argumentsList], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

test("catalog exposes exactly the approved entry surface", () => {
  const catalog = loadCatalog(rootDir);
  const all = resolveSelection(catalog, { packs: ["all"] });
  assert.deepEqual([...all.exposedSkills].sort(), entrySkills);
  assert.deepEqual(resolveSelection(catalog, { packs: ["core"] }).exposedSkills.sort(), entrySkills.filter(skill => [
    "assess-tech-design", "commit-staged", "explain-for-me", "explore-defects", "fix-strategy", "handoff"
  ].includes(skill)));
  assert.equal(all.exposedSkills.includes("agent-deck"), false);
});

test("skill get formats overview, aliases, repeated multi-selector output, and atomic errors", () => {
  const overview = command(["skill", "get", "handoff"]);
  assert.equal(overview.status, 0, overview.stderr);
  assert.match(overview.stdout, /agentgear skill get handoff start/);

  const alias = command(["skill", "get", "check-waypost-messages", "action:execute_delegate_task"]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.match(alias.stdout, /Execute Delegated Code Task/);
  assert.doesNotMatch(alias.stdout, /^---/m);

  const multi = command(["skill", "get", "check-waypost-messages", "invalid-envelope", "invalid-envelope"]);
  assert.equal(multi.status, 0, multi.stderr);
  assert.match(multi.stdout, /^agentgear skill: check-waypost-messages\/invalid-envelope/m);
  assert.equal((multi.stdout.match(/agentgear skill: check-waypost-messages\/invalid-envelope/g) ?? []).length, 2);

  const unknown = command(["skill", "get", "check-waypost-messages", "invalid-envelope", "not-real"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /agentgear skill list check-waypost-messages/);
});

test("skill list is deterministic and includes action aliases", () => {
  const result = command(["skill", "list", "check-waypost-messages", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout);
  const selectors = records.map(record => record.selector);
  assert.deepEqual(selectors, [...selectors].sort());
  assert.ok(selectors.includes("action:execute_delegate_task"));
  assert.ok(selectors.includes("invalid-envelope"));
});

test("authoritative pack install exposes entries and writes managed markers", () => {
  const item = fixture();
  try {
    const result = command(["install", "--target", "general"], item.env);
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(item.env.HOME, ".agents", "skills");
    assert.deepEqual(fs.readdirSync(target).filter(name => !name.startsWith(".")).sort(), entrySkills);
    const marker = JSON.parse(fs.readFileSync(path.join(target, "handoff", ".agentgear"), "utf8"));
    assert.equal(marker.schemaVersion, 0);
    assert.equal(marker.skill, "handoff");
    assert.equal(fs.existsSync(path.join(target, "multi-agent-protocol")), false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("legacy migration is dry-run by default and removes only whitelisted immediate children", () => {
  const item = fixture();
  try {
    const target = path.join(item.temporary, "skills");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, "handoff"));
    fs.mkdirSync(path.join(target, "not-agentgear"));
    const printed = [];
    migrateLegacySkills({ roots: [target], env: item.env, print: line => printed.push(line) });
    assert.equal(fs.existsSync(path.join(target, "handoff")), true);
    assert.match(printed.join("\n"), /would remove legacy skill: .*handoff/);
    migrateLegacySkills({ roots: [target], apply: true, env: item.env, print: () => {} });
    assert.equal(fs.existsSync(path.join(target, "handoff")), false);
    assert.equal(fs.existsSync(path.join(target, "not-agentgear")), true);
    assert.equal(LEGACY_SKILL_NAMES.length, 36);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});
