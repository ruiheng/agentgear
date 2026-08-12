import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveSelection } from "../cli/lib/catalog.mjs";
import { LEGACY_SKILL_NAMES, migrateLegacySkills } from "../cli/lib/legacy-skill-migration.mjs";
import { actionAliases, buildSkillContentIndex, validateActionTemplates, validateSkillContentIndex } from "../cli/lib/skill-content.mjs";
import { purgeRetrievedUpstreamSkills, retrievedSkillMaterializationRoot, upstreamSkillDigest } from "../cli/lib/upstreams.mjs";

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
      PATH: ""
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

function actionLookup(body) {
  const normalized = body.replace(/\r\n/g, "\n");
  if (normalized.startsWith("\n")) return null;
  const header = normalized.split("\n\n", 1)[0];
  const lines = header.split("\n");
  const actionLines = lines.filter(line => /^Action: [A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(line));
  if (actionLines.length !== 1) return null;
  if (lines.some(line => /^action:/i.test(line) && !/^Action: /.test(line))) return null;
  return `action:${actionLines[0].slice("Action: ".length)}`;
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
  assert.match(alias.stdout, /Coder Receive/);
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

test("top-level listing distinguishes the retrievable upstream skill from canonical installation skills", () => {
  const json = command(["list", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const skills = JSON.parse(json.stdout).skills;
  const upstream = skills.find(skill => skill.name === "agent-deck");
  assert.deepEqual(upstream && {
    kind: upstream.kind,
    installable: upstream.installable,
    retrievable: upstream.retrievable,
    exposure: upstream.exposure
  }, {
    kind: "upstream",
    installable: false,
    retrievable: true,
    exposure: "upstream"
  });
  assert.equal(skills.filter(skill => skill.kind === "canonical").length, 27);

  const text = command(["list"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Upstream retrievable skills: agent-deck/);
  assert.doesNotMatch(text.stdout, /Skills \(28\)/);
});

test("upstream skill get returns resourceBase from a verified runtime and rejects selectors", () => {
  const item = fixture();
  try {
    const runtime = path.join(item.env.XDG_DATA_HOME, "agentgear", "current");
    fs.cpSync(rootDir, runtime, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
    });
    const source = path.join(runtime, "catalog", "skills.json");
    const catalog = JSON.parse(fs.readFileSync(source, "utf8"));
    const upstream = catalog.upstreams["agent-deck"];
    const upstreamTree = path.join(runtime, "skills", "agent-deck");
    fs.mkdirSync(path.join(upstreamTree, "references"), { recursive: true });
    fs.writeFileSync(path.join(upstreamTree, "SKILL.md"), "# Agent Deck\nRead `references/guide.md`.\n");
    fs.writeFileSync(path.join(upstreamTree, "references", "guide.md"), "# Guide\n");
    upstream.contentDigest = upstreamSkillDigest(upstreamTree);
    fs.writeFileSync(source, `${JSON.stringify(catalog, null, 2)}\n`);
    const runtimeCommand = argumentsList => childProcess.spawnSync(
      process.execPath,
      [path.join(runtime, "bin", "agentgear.mjs"), ...argumentsList],
      { cwd: runtime, env: { ...process.env, ...item.env }, encoding: "utf8" }
    );
    const text = runtimeCommand(["skill", "get", "agent-deck"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^Base directory for this skill: /);
    assert.match(text.stdout, /# Agent Deck/);
    const json = runtimeCommand(["skill", "get", "--json", "agent-deck"]);
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.skill, "agent-deck");
    assert.equal(payload.overview, "# Agent Deck\nRead `references/guide.md`.\n");
    assert.equal(path.isAbsolute(payload.resourceBase), true);
    assert.equal(fs.readFileSync(path.join(payload.resourceBase, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal(fs.existsSync(path.join(item.env.HOME, ".agents", "skills", "agent-deck")), false);
    assert.equal(fs.existsSync(path.join(item.env.XDG_STATE_HOME, "agentgear", "installs.json")), false);
    const unknown = runtimeCommand(["skill", "get", "agent-deck", "not-real"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stdout, "");
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("receiver bootstrap specifies the strict one-lookup Action contract", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "skills", "check-waypost-messages", "references", "disclosure-start.md"),
    "utf8"
  );
  assert.match(source, /Normalize CRLF|normalize CRLF/i);
  assert.match(source, /exactly one structured-argv\s+lookup/);
  assert.match(source, /\[A-Za-z0-9\]\[A-Za-z0-9_.-\]\{0,127\}/);
  assert.match(source, /invalid-envelope/);
  assert.match(source, /unknown-action/);
  assert.doesNotMatch(source, /otherwise execute that workflow stage immediately/);
});

test("receiver parser accepts only one exact, grammar-safe Action header", () => {
  const valid = "Task: t\nAction: review_requested\nFrom: sender\n\nbody";
  assert.equal(actionLookup(valid), "action:review_requested");
  for (const body of [
    "Task: t\n\nbody",
    "Action: review_requested\nAction: stop_recommended\n\nbody",
    "action: review_requested\n\nbody",
    "Action: review requested\n\nbody",
    `Action: ${"x".repeat(129)}\n\nbody`,
    "Action: review_requested $(command)\n\nbody",
    "\nAction: review_requested\n\nbody"
  ]) {
    assert.equal(actionLookup(body), null, body);
  }
});

test("action aliases are complete, direct, and selector validation resolves multi-selector references", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  assert.deepEqual(validateSkillContentIndex(index), []);
  const aliases = actionAliases(index);
  const expected = [
    "browser_check_report", "browser_check_requested", "browser_setup_provided", "browser_setup_requested",
    "closeout_delivered", "code_delivery_complete", "code_health_review_report", "code_health_review_requested",
    "delegated_task_result", "design_spec_context_corrected", "design_spec_decision_requested", "design_spec_delivered",
    "design_spec_draft_requested", "design_spec_review_context", "design_spec_review_context_recovery_requested",
    "design_spec_review_context_rejected", "design_spec_review_report", "design_spec_review_requested",
    "execute_delegate_task", "execute_delegated_task", "execute_plan", "group_message_available",
    "plan_report_delivered", "refactor_review_report", "refactor_review_requested", "review_requested",
    "review_task_context", "rework_required", "roundtable_participant_turn", "simplify_review_report",
    "simplify_review_requested", "stop_recommended", "user_requested_iteration"
  ];
  assert.deepEqual([...aliases.keys()].sort(), expected);
  for (const token of expected) {
    const result = command(["skill", "get", "--", "check-waypost-messages", `action:${token}`]);
    assert.equal(result.status, 0, `${token}: ${result.stderr}`);
    assert.notEqual(result.stdout, "");
  }
  const discriminatorTokens = new Set([
    "browser_check_report",
    "design_spec_review_context_recovery_requested",
    "design_spec_review_requested",
    "group_message_available",
    "rework_required",
    "stop_recommended"
  ]);
  for (const token of expected) {
    if (discriminatorTokens.has(token)) continue;
    const result = command(["skill", "get", "--", "check-waypost-messages", `action:${token}`]);
    const record = aliases.get(token);
    const canonical = `${record.owner}/${record.selector}`;
    assert.equal(index.byCanonicalAddress.get(canonical), record, `${token} must directly own ${canonical}`);
    assert.equal(record.body.trim().split(/\n+/).length > 2, true, token);
    assert.doesNotMatch(result.stdout, /^# [^\n]+\n\nRetrieve `agentgear skill get [^`]+ start` and /, token);
    assert.doesNotMatch(result.stdout, /Retrieve `agentgear skill get [^`]+ start` and (?:follow|conduct|perform|process|apply|use)/, token);
    assert.doesNotMatch(result.stdout, /This is the first executable [^.]+\. Retrieve the complete /, token);
  }
  assert.equal(index.referencedSelectors.some(item => item.filePath.endsWith("multi-agent-protocol/references/disclosure-start.md") && item.selector === "tool-resolution"), true);
});

test("action-template validation rejects indented and dynamic emitted headers", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  const aliases = actionAliases(index);
  const staticRecord = [...index.byCanonicalAddress.values()][0];
  const staticIndex = {
    ...index,
    byCanonicalAddress: new Map([["fixture/static", {
      ...staticRecord,
      filePath: path.join(rootDir, "skills", "fixture", "references", "static.md"),
      body: "```markdown\nAction: review_requested\n```\n"
    }]])
  };
  assert.deepEqual(validateActionTemplates(staticIndex, aliases), []);

  for (const body of [
    "```markdown\n  Action: ${runtimeValue}\n```\n",
    "```markdown\nAction: <action>\n```\n",
    "```markdown\nAction: review_requested | stop_recommended\n```\n",
    "```markdown\nAction: $(command)\n```\n"
  ]) {
    const fixture = {
      ...index,
      byCanonicalAddress: new Map([["fixture/dynamic", {
        ...staticRecord,
        filePath: path.join(rootDir, "skills", "fixture", "references", "dynamic.md"),
        body
      }]])
    };
    assert.equal(validateActionTemplates(fixture, aliases).length, 1, body);
  }
});

test("skill and migration option boundaries reject unrelated and unsafe input", () => {
  const skill = command(["skill", "get", "--scope", "global", "handoff"]);
  assert.equal(skill.status, 1);
  assert.match(skill.stderr, /skill accepts only/);
  const migration = command(["migrate", "legacy-skills", "--dest", "relative"]);
  assert.equal(migration.status, 1);
  assert.match(migration.stderr, /absolute normalized path/);
  const list = command(["skill", "list", "agent-deck"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, "");
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

test("pack closures, explicit skills, and authoritative reconciliation expose the exact entry union", () => {
  const catalog = loadCatalog(rootDir);
  const core = entrySkills.filter(skill => [
    "assess-tech-design", "commit-staged", "explain-for-me", "explore-defects", "fix-strategy", "handoff"
  ].includes(skill));
  const workflow = entrySkills.filter(skill => !core.includes(skill));
  assert.deepEqual(resolveSelection(catalog, { packs: ["core"] }).exposedSkills.sort(), core);
  assert.deepEqual(resolveSelection(catalog, { packs: ["workflow"] }).exposedSkills.sort(), workflow);
  assert.deepEqual(resolveSelection(catalog, { packs: ["browser"] }).exposedSkills.sort(), workflow);
  assert.deepEqual(
    resolveSelection(catalog, { packs: ["core", "workflow"], skills: ["review-code"] }).exposedSkills.sort(),
    [...entrySkills, "review-code"].sort()
  );

  const item = fixture();
  try {
    let result = command(["install", "--skill", "review-code", "--target", "general"], item.env);
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(item.env.HOME, ".agents", "skills");
    assert.equal(fs.existsSync(path.join(target, "review-code", "SKILL.md")), true);
    result = command(["install", "--pack", "core", "--skill", "review-code", "--target", "general"], item.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(target).filter(name => !name.startsWith(".")).sort(), [...core, "review-code"].sort());
    result = command(["install", "--pack", "workflow", "--target", "general"], item.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(target).filter(name => !name.startsWith(".")).sort(), workflow);
    assert.equal(fs.existsSync(path.join(target, "agent-deck")), false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("authoritative reconciliation rejects a mismatched managed withdrawal before mutation", () => {
  const item = fixture();
  try {
    let result = command(["install", "--skill", "review-code", "--target", "general"], item.env);
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(item.env.HOME, ".agents", "skills");
    const managed = path.join(target, "review-code");
    const stateFile = path.join(item.env.XDG_STATE_HOME, "agentgear", "installs.json");
    const stateBefore = fs.readFileSync(stateFile, "utf8");
    fs.writeFileSync(path.join(managed, "local-change"), "do not remove\n");
    result = command(["install", "--pack", "core", "--target", "general"], item.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to withdraw locally changed skill/);
    assert.equal(fs.existsSync(managed), true);
    assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("retrieval-only full purge quarantines verified resources and preserves corrupt ones", () => {
  const item = fixture();
  try {
    const catalog = loadCatalog(rootDir);
    const source = catalog.skills.upstreams["agent-deck"];
    const plan = {
      upstream: "agent-deck",
      name: "agent-deck",
      source
    };
    const dataRoot = path.join(item.env.XDG_DATA_HOME, "agentgear");
    const root = retrievedSkillMaterializationRoot(dataRoot, plan);
    const payload = path.join(root, "payload");
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "SKILL.md"), "# Agent Deck\n");
    const digest = upstreamSkillDigest(payload);
    const pinned = { ...source, contentDigest: digest };
    const pinnedPlan = { ...plan, source: pinned };
    const pinnedRoot = retrievedSkillMaterializationRoot(dataRoot, pinnedPlan);
    if (pinnedRoot !== root) {
      fs.mkdirSync(path.dirname(pinnedRoot), { recursive: true });
      fs.renameSync(root, pinnedRoot);
    }
    fs.writeFileSync(path.join(pinnedRoot, ".agentgear-retrieved-skill.json"), `${JSON.stringify({
      schemaVersion: 1,
      name: "agent-deck",
      repository: pinned.repository,
      ref: pinned.ref,
      commit: pinned.commit,
      contentDigest: pinned.contentDigest,
      payload: "payload/SKILL.md"
    })}\n`);
    const testCatalog = structuredClone(catalog);
    testCatalog.skills.upstreams["agent-deck"] = pinned;
    testCatalog.upstreams = { "agent-deck": pinned };
    for (const host of Object.values(testCatalog.skills.sessionHosts)) {
      if (host.upstream === "agent-deck") host.upstream = "agent-deck";
    }
    const purged = purgeRetrievedUpstreamSkills({ catalog: testCatalog, env: item.env });
    assert.equal(purged.incomplete, false);
    assert.equal(fs.existsSync(pinnedRoot), false);

    fs.mkdirSync(pinnedRoot, { recursive: true });
    fs.writeFileSync(path.join(pinnedRoot, "unexpected"), "keep\n");
    const preserved = purgeRetrievedUpstreamSkills({ catalog: testCatalog, env: item.env });
    assert.equal(preserved.incomplete, true);
    assert.equal(fs.existsSync(pinnedRoot), true);
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

test("legacy migration refuses recorded state, symlink roots, and remains idempotent", () => {
  const item = fixture();
  const target = path.join(item.temporary, "skills");
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, "handoff"));
    const stateFile = path.join(item.env.XDG_STATE_HOME, "agentgear", "installs.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ schemaVersion: 2, channel: null, releases: [], targets: {}, commands: {} })}\n`);
    assert.throws(
      () => migrateLegacySkills({ roots: [target], apply: true, env: item.env }),
      /recorded Agentgear installation exists/
    );
    fs.rmSync(stateFile);
    const linkedRoot = path.join(item.temporary, "linked-skills");
    fs.symlinkSync(target, linkedRoot);
    assert.throws(
      () => migrateLegacySkills({ roots: [linkedRoot], apply: true, env: item.env }),
      /Unsafe legacy migration root/
    );
    const first = migrateLegacySkills({ roots: [target], apply: true, env: item.env, print: () => {} });
    const second = migrateLegacySkills({ roots: [target], apply: true, env: item.env, print: () => {} });
    assert.deepEqual(first.removed, [path.join(target, "handoff")]);
    assert.deepEqual(second.removed, []);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});
