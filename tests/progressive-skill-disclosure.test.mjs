import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCatalog, resolveSelection } from "../cli/lib/catalog.mjs";
import { LEGACY_SKILL_NAMES, migrateLegacySkills } from "../cli/lib/legacy-skill-migration.mjs";
import { actionAliases, buildSkillContentIndex, listSkillSelectors, resolveSkillAddress, validateActionTemplates, validateSkillContentIndex } from "../cli/lib/skill-content.mjs";
import { purgeRetrievedUpstreamSkills, retrieveUpstreamSkill, retrievedSkillMaterializationRoot, upstreamSkillDigest } from "../cli/lib/upstreams.mjs";
import { actionHeader, loadActionProducerManifest } from "../skills/multi-agent-protocol/scripts/action-producer.mjs";

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

function contentIndexFixture({ skill = "fixture", selector = "start", aliases = [], upstreams = {}, includeEntry = true } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-content-index-test-"));
  const skillRoot = path.join(temporary, "skills", skill);
  fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# Fixture\n");
  fs.writeFileSync(path.join(skillRoot, "references", "slice.md"), [
    "---",
    `skill-selector: ${selector}`,
    "selector-summary: Fixture slice.",
    ...(aliases.length > 0 ? [`selector-aliases: ${aliases.join(", ")}`] : []),
    "---",
    "",
    "# Slice",
    ""
  ].join("\n"));
  if (includeEntry && selector !== "start") {
    fs.writeFileSync(path.join(skillRoot, "references", "entry.md"), [
      "---",
      "skill-selector: start",
      "selector-summary: Fixture entry.",
      "---",
      "",
      "# Entry",
      ""
    ].join("\n"));
  }
  return {
    temporary,
    catalog: { skills: { skills: { [skill]: {} }, upstreams } }
  };
}

function actionRoute(body) {
  const normalized = body.replace(/\r\n/g, "\n");
  const header = normalized.startsWith("\n") ? "" : normalized.split("\n\n", 1)[0];
  const lines = header.split("\n");
  const actionFields = lines.filter(line => /^\s*action\s*:/i.test(line));
  if (actionFields.length === 0) return { kind: "plain" };
  const actionLines = lines.filter(line => /^Action: [A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(line));
  if (actionFields.length !== 1 || actionLines.length !== 1) return { kind: "invalid" };
  return { kind: "action", address: `action:${actionLines[0].slice("Action: ".length)}` };
}

function pinnedCatalogWithPayload(catalog, payload) {
  const pinned = { ...catalog.skills.upstreams["agent-deck"], contentDigest: upstreamSkillDigest(payload) };
  const result = structuredClone(catalog);
  result.skills.upstreams["agent-deck"] = pinned;
  result.upstreams = { "agent-deck": pinned };
  return { catalog: result, plan: { upstream: "agent-deck", name: "agent-deck", source: pinned } };
}

function materializeRetrievedSkill(root, plan, contents = "# Agent Deck\n") {
  const payload = path.join(root, "payload");
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, "SKILL.md"), contents);
  fs.writeFileSync(path.join(root, ".agentgear-retrieved-skill.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: plan.name,
    repository: plan.source.repository,
    ref: plan.source.ref,
    commit: plan.source.commit,
    contentDigest: plan.source.contentDigest,
    payload: "payload/SKILL.md"
  })}\n`);
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

test("canonical bootstraps ask agents to remember guidance without repeating global policy", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog);
  for (const skill of Object.keys(catalog.skills.skills)) {
    const source = fs.readFileSync(path.join(rootDir, "skills", skill, "SKILL.md"), "utf8");
    assert.match(source, new RegExp("Follow the remembered guidance from `agentgear skill get " + skill + "`\\. Run it only if you no longer remember the guidance or have evidence it changed\\."));
    assert.equal(resolveSkillAddress(index, skill).owner, skill);
    assert.doesNotMatch(source, /Agentgear skill text is stable/);
    assert.doesNotMatch(source, /Repeat that command after compaction/);
  }
});

test("skill help states the stable guidance policy once", () => {
  const result = command(["skill", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skill text is stable\. Remember and reuse it; reload only if you no longer remember it,/);
  assert.match(result.stdout, /the user asks, or there is evidence it changed\./);
});

test("skill get resolves independent addresses, global fallbacks, and atomic errors", () => {
  const entry = command(["skill", "get", "handoff"]);
  assert.equal(entry.status, 0, entry.stderr);
  assert.match(entry.stdout, /# Handoff/);

  const alias = command(["skill", "get", "action:execute_delegate_task"]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.match(alias.stdout, /Coder Receive/);
  assert.doesNotMatch(alias.stdout, /^---/m);

  const fallback = command(["skill", "get", "session-host"]);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /Session Host Contract/);

  const multi = command(["skill", "get", "check-waypost-messages/invalid-envelope", "tech-design-workflow/report-handling"]);
  assert.equal(multi.status, 0, multi.stderr);
  assert.match(multi.stdout, /^agentgear skill: check-waypost-messages\/invalid-envelope/m);
  assert.match(multi.stdout, /^agentgear skill: tech-design-workflow\/report-handling/m);

  const ambiguous = command(["skill", "get", "continue-1"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /Ambiguous skill address continue-1/);

  const unknown = command(["skill", "get", "check-waypost-messages/invalid-envelope", "not-real"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown skill address: not-real/);
});

test("skill list is deterministic and emits directly resolvable owned addresses", () => {
  const result = command(["skill", "list", "check-waypost-messages", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout);
  const selectors = records.map(record => record.selector);
  assert.deepEqual(selectors, [...selectors].sort());
  assert.ok(selectors.includes("action:group_message_available"));
  assert.ok(selectors.includes("check-waypost-messages/invalid-envelope"));

  const planReport = command(["skill", "list", "plan-report"]);
  assert.equal(planReport.status, 0, planReport.stderr);
  const addresses = planReport.stdout.trim().split("\n");
  assert.deepEqual(addresses, ["action:plan_report_delivered", "plan-report/receive", "plan-report/start"]);
  for (const address of addresses) {
    const lookup = command(["skill", "get", address]);
    assert.equal(lookup.status, 0, `${address}: ${lookup.stderr}`);
  }
});

test("selector aliases cannot shadow canonical or upstream skill entry addresses", () => {
  for (const [alias, upstreams] of [["fixture", {}], ["agent-deck", { "agent-deck": {} }]]) {
    const item = contentIndexFixture({ aliases: [alias], upstreams });
    try {
      assert.throws(
        () => buildSkillContentIndex(item.temporary, item.catalog),
        new RegExp(`Selector alias shadows skill entry address: ${alias}`)
      );
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("every canonical skill owns its entry address", () => {
  const missing = contentIndexFixture({ selector: "review", includeEntry: false });
  try {
    assert.throws(
      () => buildSkillContentIndex(missing.temporary, missing.catalog),
      /Skill has no entry address: fixture/
    );
  } finally {
    fs.rmSync(missing.temporary, { recursive: true, force: true });
  }

  const foreign = contentIndexFixture({ selector: "review", includeEntry: false });
  try {
    const otherRoot = path.join(foreign.temporary, "skills", "other");
    fs.mkdirSync(path.join(otherRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(otherRoot, "SKILL.md"), "# Other\n");
    fs.writeFileSync(path.join(otherRoot, "references", "start.md"), [
      "---",
      "skill-selector: start",
      "selector-summary: Other entry.",
      "selector-aliases: fixture/start",
      "---",
      "",
      "# Other",
      ""
    ].join("\n"));
    foreign.catalog.skills.skills.other = {};
    assert.throws(
      () => buildSkillContentIndex(foreign.temporary, foreign.catalog),
      /Skill entry address fixture\/start is owned by other/
    );
  } finally {
    fs.rmSync(foreign.temporary, { recursive: true, force: true });
  }
});

test("qualified aliases resolve even when their prefix is not a catalog skill", () => {
  const item = contentIndexFixture({ aliases: ["legacy/entry"] });
  try {
    const index = buildSkillContentIndex(item.temporary, item.catalog);
    const record = resolveSkillAddress(index, "legacy/entry");
    assert.equal(record.owner, "fixture");
    assert.equal(record.canonicalSelector, "start");
    assert.equal(record.requestedAddress, "legacy/entry");
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("bare aliases must resolve to one canonical slice", () => {
  function addSlice(item, skill, selector, aliases = []) {
    const skillRoot = path.join(item.temporary, "skills", skill);
    fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `# ${skill}\n`);
    fs.writeFileSync(path.join(skillRoot, "references", `${selector}.md`), [
      "---",
      `skill-selector: ${selector}`,
      "selector-summary: Test slice.",
      ...(aliases.length > 0 ? [`selector-aliases: ${aliases.join(", ")}`] : []),
      "---",
      "",
      "# Slice",
      ""
    ].join("\n"));
    if (selector !== "start") {
      fs.writeFileSync(path.join(skillRoot, "references", "entry.md"), [
        "---",
        "skill-selector: start",
        "selector-summary: Test entry.",
        "---",
        "",
        "# Entry",
        ""
      ].join("\n"));
    }
    item.catalog.skills.skills[skill] = {};
  }

  for (const conflictingSlice of [
    ["a", "foo", []],
    ["a", "start", ["legacy/foo"]]
  ]) {
    const item = contentIndexFixture({ skill: "b", aliases: ["foo"] });
    try {
      addSlice(item, ...conflictingSlice);
      assert.throws(
        () => buildSkillContentIndex(item.temporary, item.catalog),
        /Ambiguous bare selector alias foo; conflicts with: a\/(?:foo|start), b\/start/
      );
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }

  const sameTarget = contentIndexFixture({ aliases: ["foo", "legacy/foo"] });
  try {
    const index = buildSkillContentIndex(sameTarget.temporary, sameTarget.catalog);
    assert.equal(resolveSkillAddress(index, "foo").canonicalSelector, "start");
  } finally {
    fs.rmSync(sameTarget.temporary, { recursive: true, force: true });
  }
});

test("selector discovery lists aliases only under their owning skill", () => {
  const item = contentIndexFixture({ aliases: ["other/entry"] });
  try {
    const otherRoot = path.join(item.temporary, "skills", "other");
    fs.mkdirSync(path.join(otherRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(otherRoot, "SKILL.md"), "# Other\n");
    fs.writeFileSync(path.join(otherRoot, "references", "entry.md"), [
      "---",
      "skill-selector: start",
      "selector-summary: Other entry.",
      "---",
      "",
      "# Other",
      ""
    ].join("\n"));
    item.catalog.skills.skills.other = {};
    const index = buildSkillContentIndex(item.temporary, item.catalog);
    assert.equal(listSkillSelectors(index, "fixture").some(record => record.selector === "other/entry"), true);
    assert.deepEqual(listSkillSelectors(index, "other").map(record => record.selector), ["other/start"]);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("reference validation accepts upstream entries but rejects their subaddresses", () => {
  const item = contentIndexFixture({ upstreams: { "agent-deck": {} } });
  const overviewPath = path.join(item.temporary, "skills", "fixture", "SKILL.md");
  try {
    fs.writeFileSync(overviewPath, "Run `agentgear skill get agent-deck`.\n");
    assert.deepEqual(validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog)), []);

    fs.writeFileSync(overviewPath, "Run `agentgear skill get agent-deck/not-real`.\n");
    let errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
    assert.equal(errors.some(error => /Unknown skill: agent-deck/.test(error)), true);

    for (const addresses of ["agent-deck fixture/start", "fixture/start agent-deck"]) {
      fs.writeFileSync(overviewPath, `Run \`agentgear skill get ${addresses}\`.\n`);
      errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
      assert.equal(errors.some(error => /Upstream skill agent-deck cannot be combined with other addresses/.test(error)), true);
    }
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("canonical and alias addresses share the 256-character index limit", () => {
  const cases = [
    { selector: "s".repeat(248), valid: true },
    { selector: "s".repeat(249), valid: false },
    { aliases: [`alias/${"s".repeat(250)}`], valid: true },
    { aliases: [`alias/${"s".repeat(251)}`], valid: false }
  ];
  for (const testCase of cases) {
    const item = contentIndexFixture(testCase);
    try {
      if (testCase.valid) {
        assert.doesNotThrow(() => buildSkillContentIndex(item.temporary, item.catalog));
      } else {
        assert.throws(() => buildSkillContentIndex(item.temporary, item.catalog), /Invalid (?:selector address|selector alias)/);
      }
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
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
    assert.equal(payload.selections[0].address, "agent-deck");
    assert.equal(payload.selections[0].body, "# Agent Deck\nRead `references/guide.md`.\n");
    assert.equal(path.isAbsolute(payload.resourceBase), true);
    assert.equal(fs.readFileSync(path.join(payload.resourceBase, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal(fs.existsSync(path.join(item.env.HOME, ".agents", "skills", "agent-deck")), false);
    assert.equal(fs.existsSync(path.join(item.env.XDG_STATE_HOME, "agentgear", "installs.json")), false);
    const unknown = runtimeCommand(["skill", "get", "agent-deck/not-real"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stdout, "");
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("skill get works through source, staged release, shared current, and copy-fallback launchers", () => {
  const item = fixture();
  try {
    const source = command(["skill", "get", "handoff"], item.env);
    assert.equal(source.status, 0, source.stderr);
    const runtime = path.join(item.env.XDG_DATA_HOME, "agentgear", "releases", "fixture-release");
    fs.cpSync(rootDir, runtime, {
      recursive: true,
      filter: sourcePath => ![".git", "dist", "node_modules"].includes(path.basename(sourcePath))
    });
    const invokeRuntime = executable => childProcess.spawnSync(
      process.execPath,
      [executable, "skill", "get", "handoff"],
      { cwd: runtime, env: { ...process.env, ...item.env }, encoding: "utf8" }
    );
    const staged = invokeRuntime(path.join(runtime, "bin", "agentgear.mjs"));
    assert.equal(staged.status, 0, staged.stderr);
    fs.mkdirSync(path.dirname(path.join(item.env.XDG_DATA_HOME, "agentgear", "current")), { recursive: true });
    fs.symlinkSync(runtime, path.join(item.env.XDG_DATA_HOME, "agentgear", "current"), "dir");
    const shared = invokeRuntime(path.join(item.env.XDG_DATA_HOME, "agentgear", "current", "bin", "agentgear.mjs"));
    assert.equal(shared.status, 0, shared.stderr);
    const fallback = path.join(runtime, "fallback", "bin", "agentgear.mjs");
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.symlinkSync(path.join(runtime, "cli"), path.join(runtime, "fallback", "cli"), "dir");
    fs.copyFileSync(path.join(runtime, "bin", "agentgear.mjs"), fallback);
    const copied = invokeRuntime(fallback);
    assert.equal(copied.status, 0, copied.stderr);
    for (const result of [staged, shared, copied]) assert.equal(result.stdout, source.stdout);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("receiver bootstrap separates ordinary messages from safe one-lookup Action routing", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "skills", "check-waypost-messages", "references", "disclosure-start.md"),
    "utf8"
  );
  assert.match(source, /Call `waypost_status` once to initialize MCP tool discovery/);
  assert.match(source, /If unavailable,\s+use the Waypost CLI/);
  assert.match(source, /Normalize CRLF|normalize CRLF/i);
  assert.equal(source.includes("`^\\s*Action\\s*:`"), true);
  assert.equal(source.includes("`^\\\\s*Action\\\\s*:`"), false);
  assert.match(source, /structured argv[\s\S]*exactly once/);
  assert.match(source, /\[A-Za-z0-9\]\[A-Za-z0-9_.-\]\{0,127\}/);
  assert.match(source, /invalid-envelope/);
  assert.match(source, /unknown-action/);
  assert.match(source, /ordinary\s+personal message/);
  assert.doesNotMatch(source, /reject a missing Action/);
  assert.doesNotMatch(source, /otherwise execute that workflow stage immediately/);
});

test("receiver parser treats missing Action as plain and rejects explicit malformed Action fields", () => {
  const valid = "Task: t\nAction: review_requested\nFrom: sender\n\nbody";
  assert.deepEqual(actionRoute(valid), { kind: "action", address: "action:review_requested" });
  for (const body of [
    "Task: t\nFrom: sender\n\nbody",
    "Round 3 review completed.\n\nDecision: NEEDS_REVISION",
    "\nordinary body"
  ]) {
    assert.deepEqual(actionRoute(body), { kind: "plain" }, body);
  }
  for (const body of [
    "Action: review_requested\nAction: stop_recommended\n\nbody",
    "action: review_requested\n\nbody",
    " Action: review_requested\n\nbody",
    "Action : review_requested\n\nbody",
    "Action: review requested\n\nbody",
    `Action: ${"x".repeat(129)}\n\nbody`,
    "Action: review_requested $(command)\n\nbody"
  ]) {
    assert.deepEqual(actionRoute(body), { kind: "invalid" }, body);
  }
});

test("routing rejection replies to the sender, then acknowledges or fails without release", () => {
  const invalid = fs.readFileSync(path.join(rootDir, "skills", "check-waypost-messages", "references", "invalid-envelope.md"), "utf8");
  const unknown = fs.readFileSync(path.join(rootDir, "skills", "check-waypost-messages", "references", "unknown-action.md"), "utf8");
  const rejected = fs.readFileSync(path.join(rootDir, "skills", "check-waypost-messages", "references", "message-rejected.md"), "utf8");
  for (const source of [invalid, unknown]) {
    assert.match(source, /received `sender_address`/);
    assert.match(source, /current `recipient_address` as sender/);
    assert.match(source, /Action: message_rejected/);
    assert.match(source, /acknowledge the rejected delivery/);
    assert.match(source, /structured argv `\[executable,"--state-dir",state_dir,"fail"/);
    assert.match(source, /Report its returned state/);
    assert.match(source, /never release this delivery/);
  }
  assert.match(rejected, /Do not reply to the rejection/);
  assert.match(rejected, /resend it once/);

  const delivery = fs.readFileSync(path.join(rootDir, "skills", "review-tech-design", "references", "message-delivery.md"), "utf8");
  assert.match(delivery, /Send the complete report form above as the Waypost body/);
  assert.match(delivery, /never replace it with a summary/);
  assert.match(delivery, /Action: design_spec_review_report/);
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
    "execute_delegate_task", "execute_delegated_task", "execute_plan", "group_message_available", "message_rejected",
    "plan_report_delivered", "refactor_review_report", "refactor_review_requested", "review_requested",
    "review_task_context", "rework_required", "roundtable_participant_turn", "simplify_review_report",
    "simplify_review_requested", "stop_recommended", "user_requested_iteration"
  ];
  assert.deepEqual([...aliases.keys()].sort(), expected);
  for (const token of expected) {
    const result = command(["skill", "get", "--", `action:${token}`]);
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
    const result = command(["skill", "get", "--", `action:${token}`]);
    const record = aliases.get(token);
    const canonical = `${record.owner}/${record.selector}`;
    assert.equal(index.byCanonicalAddress.get(canonical), record, `${token} must directly own ${canonical}`);
    assert.equal(record.body.trim().split(/\n+/).length > 2, true, token);
    assert.doesNotMatch(result.stdout, /^# [^\n]+\n\nRetrieve `agentgear skill get [^`]+ start` and /, token);
    assert.doesNotMatch(result.stdout, /Retrieve `agentgear skill get [^`]+ start` and (?:follow|conduct|perform|process|apply|use)/, token);
    assert.doesNotMatch(result.stdout, /This is the first executable [^.]+\. Retrieve the complete /, token);
  }
  const directStages = {
    execute_delegate_task: ["## Coder Receive", "On `Action: execute_delegate_task`"],
    execute_delegated_task: ["## Worker Receive", "On `Action: execute_delegated_task`"],
    browser_setup_requested: ["## Setup Request Receive", "tester_workspace"],
    browser_setup_provided: ["## Setup Reply Receive", "matching check history"],
    browser_check_report: ["# Browser Check Report Route", "review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3"]
  };
  for (const [token, [stage, requiredText]] of Object.entries(directStages)) {
    const result = command(["skill", "get", "--", `action:${token}`]);
    assert.equal(result.status, 0, `${token}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(stage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const coder = command(["skill", "get", "--", "action:execute_delegate_task"]);
  const worker = command(["skill", "get", "--", "action:execute_delegated_task"]);
  assert.equal(coder.stdout.trimStart().startsWith("## Coder Receive"), true);
  assert.equal(worker.stdout.trimStart().startsWith("## Worker Receive"), true);
  assert.equal(index.referencedInvocations.some(item => item.filePath.endsWith("multi-agent-protocol/references/disclosure-start.md") && item.addresses.includes("multi-agent-protocol/tool-resolution")), true);
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

test("declared Action producer boundary rejects dynamic tokens and forged declarations", () => {
  const declarations = loadActionProducerManifest(
    pathToFileURL(path.join(rootDir, "skills", "multi-agent-protocol", "scripts", "action-producers.mjs")).href
  );
  const action = declarations.actions.REVIEW_TASK_CONTEXT;
  assert.equal(actionHeader(action), "Action: review_task_context");
  assert.throws(() => actionHeader("review_requested"), /declared Action value/);
  assert.throws(() => actionHeader({ token: "review_requested" }), /declared Action value/);
  assert.throws(() => actionHeader({}), /declared Action value/);
  assert.throws(() => loadActionProducerManifest(import.meta.url), /may only load/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(rootDir, "skills", "multi-agent-protocol", "scripts", "action-producer.mjs"), "utf8"),
    /export\s+(?:function|const)\s+sendActionMessage\b/
  );
  const message = declarations.factories.REVIEW_TASK_CONTEXT({
    before: [{ name: "Task", value: "t" }],
    after: [],
    body: "body"
  });
  let sent;
  const result = declarations.senders.REVIEW_TASK_CONTEXT(message, {
    toAddress: "agent-deck/reviewer-1",
    fromAddress: "agent-deck/planner-1",
    subject: "review",
    contentType: "text/markdown",
    schemaVersion: "1",
    runCommand(command, commandArgs, options) {
      sent = { command, commandArgs, options };
      return { status: 0 };
    }
  });
  assert.equal(result.status, 0);
  assert.equal(sent.command, "waypost");
  assert.equal(sent.options.input, "Task: t\nAction: review_task_context\n\nbody");
  assert.deepEqual(
    sent.options.input.split("\n\n", 1)[0].match(/^action:.*$/gim),
    ["Action: review_task_context"]
  );
  const newline = String.fromCharCode(10);
  let accessorValueReads = 0;
  const accessorField = { name: "Task" };
  Object.defineProperty(accessorField, "value", {
    enumerable: true,
    get() {
      accessorValueReads += 1;
      return accessorValueReads === 1
        ? "safe"
        : `safe${newline}Action: not_registered${newline}${newline}`;
    }
  });
  const accessorMessage = declarations.factories.REVIEW_TASK_CONTEXT({
    before: [accessorField], after: [], body: "body"
  });
  let accessorInput;
  declarations.senders.REVIEW_TASK_CONTEXT(accessorMessage, {
    toAddress: "agent-deck/reviewer-1",
    fromAddress: "agent-deck/planner-1",
    subject: "review",
    contentType: "text/markdown",
    schemaVersion: "1",
    runCommand(command, commandArgs, options) {
      accessorInput = options.input;
      return { status: 0 };
    }
  });
  assert.equal(accessorValueReads, 1);
  assert.equal(accessorInput, "Task: safe\nAction: review_task_context\n\nbody");

  let proxyNameReads = 0;
  let proxyValueReads = 0;
  const proxyField = new Proxy({ name: "Task", value: "safe" }, {
    get(target, property, receiver) {
      if (property === "name") {
        proxyNameReads += 1;
        return proxyNameReads === 1 ? "Task" : "Action";
      }
      if (property === "value") {
        proxyValueReads += 1;
        return proxyValueReads === 1 ? "safe" : `safe${newline}Action: not_registered${newline}${newline}`;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const proxyMessage = declarations.factories.REVIEW_TASK_CONTEXT({
    before: [proxyField], after: [], body: "body"
  });
  let proxyInput;
  declarations.senders.REVIEW_TASK_CONTEXT(proxyMessage, {
    toAddress: "agent-deck/reviewer-1",
    fromAddress: "agent-deck/planner-1",
    subject: "review",
    contentType: "text/markdown",
    schemaVersion: "1",
    runCommand(command, commandArgs, options) {
      proxyInput = options.input;
      return { status: 0 };
    }
  });
  assert.equal(proxyNameReads, 1);
  assert.equal(proxyValueReads, 1);
  assert.equal(proxyInput, "Task: safe\nAction: review_task_context\n\nbody");
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: new Array(1), after: [], body: "body"
  }), /header 1 must have string name and value/);
  assert.throws(() => declarations.senders.REVIEW_TASK_CONTEXT({}, {}), /Waypost Action destination is required/);
  assert.throws(() => declarations.senders.EXECUTE_DELEGATE_TASK(message, {
    toAddress: "to", fromAddress: "from", subject: "subject", contentType: "text/markdown", schemaVersion: "1"
  }), /does not match its declared producer route/);
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: [{ name: "Action", value: "not_registered" }], after: [], body: "body"
  }), /may not set Action/);
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: [], after: [{ name: "aCtIoN", value: "not_registered" }], body: "body"
  }), /may not set Action/);
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: [{ name: "Task", value: "t" }], after: [{ name: "task", value: "other" }], body: "body"
  }), /duplicate header task/);
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: [{ name: "Action ", value: "not_registered" }], after: [], body: "body"
  }), /invalid name/);
  assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
    before: [{ name: "Task", value: "t\nAction: not_registered" }], after: [], body: "body"
  }), /unsafe value/);
});

test("action-template validation checks every declared Waypost sender without parsing inert JavaScript", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  const aliases = actionAliases(index);
  const declaration = path.join(rootDir, "skills", "multi-agent-protocol", "action-producers.json");
  const original = fs.readFileSync(declaration, "utf8");
  try {
    const cleanProducerSyntax = [
      "const body = \"Act\" + \"ion: \" + \"not_registered\";",
      "const body = [\"Action\", runtimeValue].join(\": \");",
      "let header = \"Action: review_requested\"; header = runtimeValue; const body = `${header}`;",
      "const header = \"Action: review_requested\"; function emit(header) { return `${header}`; }",
      "const example = \"Action: not_registered\";",
      "/* Action: not_registered */",
      String.raw`const pattern = /Action: ([^\\n]+)/;`
    ].join("\n");
    fs.writeFileSync(path.join(rootDir, "skills", "multi-agent-protocol", "scripts", "producer-fixture.mjs"), cleanProducerSyntax);
    const cleanIndex = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
    assert.deepEqual(validateActionTemplates(cleanIndex, aliases), []);

    const invalid = JSON.parse(original);
    invalid.actions.REVIEW_TASK_CONTEXT.token = "not_registered";
    fs.writeFileSync(declaration, `${JSON.stringify(invalid, null, 2)}\n`);
    const invalidIndex = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
    assert.equal(validateActionTemplates(invalidIndex, aliases).some(error => /action-producers\.json: unregistered Action token not_registered/.test(error)), true);

    const missingBoundary = JSON.parse(original);
    missingBoundary.actions.REVIEW_TASK_CONTEXT.script = "producer-fixture.mjs";
    fs.writeFileSync(declaration, `${JSON.stringify(missingBoundary, null, 2)}\n`);
    const boundaryIndex = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
    assert.equal(validateActionTemplates(boundaryIndex, aliases).some(error => /Action producer script does not reference declared factory reviewTaskContextMessage/.test(error)), true);
  } finally {
    fs.writeFileSync(declaration, original);
    fs.rmSync(path.join(rootDir, "skills", "multi-agent-protocol", "scripts", "producer-fixture.mjs"), { force: true });
  }
});

test("Action producer manifests cover every actual sender exactly once", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  const aliases = actionAliases(index);
  const expected = new Map([
    [
      path.join(rootDir, "skills", "multi-agent-protocol", "scripts", "send-delegate-with-active-task-lock.mjs"),
      ["review_task_context", "execute_delegate_task"]
    ],
    [
      path.join(rootDir, "skills", "tech-design-workflow", "scripts", "send-design-draft-with-review-context.mjs"),
      ["design_spec_review_context", "design_spec_draft_requested"]
    ]
  ]);
  const actual = new Map();
  for (const skill of index.names) {
    const declarationPath = path.join(rootDir, "skills", skill, "action-producers.json");
    if (!fs.existsSync(declarationPath)) continue;
    const declaration = JSON.parse(fs.readFileSync(declarationPath, "utf8"));
    for (const value of Object.values(declaration.actions)) {
      const script = path.join(rootDir, "skills", skill, "scripts", value.script);
      const tokens = actual.get(script) ?? [];
      tokens.push({ token: value.token, factory: value.factory, sender: value.sender });
      actual.set(script, tokens);
    }
  }
  assert.deepEqual(
    [...actual.entries()].map(([script, entries]) => [script, entries.map(entry => entry.token).sort()]).sort(([left], [right]) => left.localeCompare(right)),
    [...expected.entries()].map(([script, tokens]) => [script, [...tokens].sort()]).sort(([left], [right]) => left.localeCompare(right))
  );
  for (const [script, entries] of actual) {
    const source = fs.readFileSync(script, "utf8");
    assert.doesNotMatch(source, /\bsendActionMessage\s*\(/, script);
    for (const { token, factory, sender } of entries) {
      assert.equal(aliases.has(token), true, token);
      assert.match(source, new RegExp(`(?:\\b${factory}\\s*\\(|\\(\\s*${factory}\\s*,)`), `${script} must pass ${factory}`);
      assert.match(source, new RegExp(`(?:\\b${sender}\\s*\\(|\\(\\s*${sender}\\s*,)`), `${script} must pass ${sender}`);
    }
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

test("retrieved skill creation is atomic under a concurrent winning materialization", () => {
  const item = fixture();
  try {
    const sourceTree = path.join(item.temporary, "source");
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const { catalog, plan } = pinnedCatalogWithPayload(loadCatalog(rootDir), sourceTree);
    const finalRoot = retrievedSkillMaterializationRoot(path.join(item.env.XDG_DATA_HOME, "agentgear"), plan);
    const result = retrieveUpstreamSkill({
      catalog,
      skill: "agent-deck",
      env: item.env,
      provision: ({ runtime }) => {
        fs.mkdirSync(path.join(runtime.root, "skills"), { recursive: true });
        fs.cpSync(sourceTree, path.join(runtime.root, "skills", "agent-deck"), { recursive: true });
      },
      rename(temporary, destination) {
        assert.equal(destination, finalRoot);
        materializeRetrievedSkill(destination, plan);
        const error = new Error("destination exists");
        error.code = "EEXIST";
        throw error;
      }
    });
    assert.equal(result.payload, path.join(finalRoot, "payload"));
    assert.equal(fs.readFileSync(path.join(result.payload, "SKILL.md"), "utf8"), "# Agent Deck\n");
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("retrieved skill materializations reject symlink and unexpected shapes without affecting normal commands", () => {
  if (process.platform === "win32") return;
  const item = fixture();
  try {
    const sourceTree = path.join(item.temporary, "source");
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const { catalog, plan } = pinnedCatalogWithPayload(loadCatalog(rootDir), sourceTree);
    const root = retrievedSkillMaterializationRoot(path.join(item.env.XDG_DATA_HOME, "agentgear"), plan);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(sourceTree, root, "dir");
    assert.throws(
      () => retrieveUpstreamSkill({ catalog, skill: "agent-deck", env: item.env }),
      /Retrieved upstream skill is unverifiable/
    );
    assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
    const normal = command(["install", "--skill", "handoff", "--target", "general"], item.env);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("upstream retrieval rejects symlinked managed parents without writing through them", () => {
  if (process.platform === "win32") return;
  for (const parent of ["retrieved-skills", path.join("retrieved-skills", "agent-deck")]) {
    const item = fixture();
    try {
      const sourceTree = path.join(item.temporary, "source");
      const outside = path.join(item.temporary, "outside");
      fs.mkdirSync(sourceTree, { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
      const { catalog } = pinnedCatalogWithPayload(loadCatalog(rootDir), sourceTree);
      const dataRoot = path.join(item.env.XDG_DATA_HOME, "agentgear");
      const managedParent = path.join(dataRoot, parent);
      fs.mkdirSync(path.dirname(managedParent), { recursive: true });
      fs.symlinkSync(outside, managedParent, "dir");

      assert.throws(
        () => retrieveUpstreamSkill({ catalog, skill: "agent-deck", env: item.env }),
        /Retrieved upstream skill parent is not a real directory/
      );
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.equal(fs.lstatSync(managedParent).isSymbolicLink(), true);
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("technical-design delivery overview uses the direct requester-delivery route", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog);
  const overview = resolveSkillAddress(index, "tech-design-workflow").body;
  const requesterHandling = resolveSkillAddress(index, "tech-design-workflow/requester-handling").body;
  const delivered = resolveSkillAddress(index, "action:design_spec_delivered");

  assert.match(overview, /`design_spec_delivered`: retrieve `agentgear skill get tech-design-workflow\/requester-delivery`/);
  assert.equal(delivered.owner, "tech-design-workflow");
  assert.equal(delivered.canonicalSelector, "requester-delivery");
  assert.doesNotMatch(requesterHandling, /design_spec_delivered|closeout\.md/);
});

test("retrieved-skill purge preserves old pins and rolls a failed quarantine removal back", () => {
  const item = fixture();
  try {
    const sourceTree = path.join(item.temporary, "source");
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const { catalog, plan } = pinnedCatalogWithPayload(loadCatalog(rootDir), sourceTree);
    const dataRoot = path.join(item.env.XDG_DATA_HOME, "agentgear");
    const root = retrievedSkillMaterializationRoot(dataRoot, plan);
    materializeRetrievedSkill(root, plan);
    const oldPin = path.join(path.dirname(root), "0".repeat(64));
    fs.mkdirSync(oldPin, { recursive: true });
    fs.writeFileSync(path.join(oldPin, "legacy"), "keep\n");
    const purged = purgeRetrievedUpstreamSkills({
      catalog,
      env: item.env,
      remove() {
        throw new Error("simulated removal failure");
      }
    });
    assert.equal(purged.incomplete, true);
    assert.equal(fs.existsSync(root), true, "failed removal restored the verified materialization");
    assert.equal(fs.existsSync(oldPin), true, "older pin is preserved");
    assert.equal(purged.preserved.includes(oldPin), true);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("target-limited purge retains retrieved materializations", () => {
  const item = fixture();
  try {
    const sourceTree = path.join(item.temporary, "source");
    fs.mkdirSync(sourceTree, { recursive: true });
    fs.writeFileSync(path.join(sourceTree, "SKILL.md"), "# Agent Deck\n");
    const { catalog, plan } = pinnedCatalogWithPayload(loadCatalog(rootDir), sourceTree);
    const dataRoot = path.join(item.env.XDG_DATA_HOME, "agentgear");
    const materialization = retrievedSkillMaterializationRoot(dataRoot, plan);
    materializeRetrievedSkill(materialization, plan);

    const installed = command(["install", "--skill", "handoff", "--target", "general"], item.env);
    assert.equal(installed.status, 0, installed.stderr);
    const purge = command(["uninstall", "--purge", "--target", "general"], item.env);
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(fs.existsSync(materialization), true);
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

test("legacy migration removes a whitelisted symlink child without traversing it", () => {
  if (process.platform === "win32") return;
  const item = fixture();
  try {
    const target = path.join(item.temporary, "skills");
    const outside = path.join(item.temporary, "outside");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "preserve.txt"), "keep\n");
    fs.symlinkSync(outside, path.join(target, "handoff"), "dir");
    migrateLegacySkills({ roots: [target], apply: true, env: item.env, print: () => {} });
    assert.equal(fs.existsSync(path.join(target, "handoff")), false);
    assert.equal(fs.readFileSync(path.join(outside, "preserve.txt"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("legacy migration performs full-scope preflight and rolls moved children back", () => {
  const item = fixture();
  try {
    const target = path.join(item.temporary, "skills");
    fs.mkdirSync(path.join(target, "handoff"), { recursive: true });
    fs.mkdirSync(path.join(target, "review-code"), { recursive: true });
    let moves = 0;
    assert.throws(
      () => migrateLegacySkills({
        roots: [target],
        apply: true,
        env: item.env,
        print: () => {},
        rename(source, destination) {
          moves += 1;
          if (moves === 2) throw new Error("simulated second move failure");
          fs.renameSync(source, destination);
        }
      }),
      /simulated second move failure/
    );
    assert.equal(fs.existsSync(path.join(target, "handoff")), true);
    assert.equal(fs.existsSync(path.join(target, "review-code")), true);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("legacy migration CLI resolves default Kiro, explicit target, project, and destination roots", () => {
  const item = fixture();
  try {
    const globalRoots = [
      path.join(item.env.HOME, ".agents", "skills"),
      path.join(item.env.HOME, ".claude", "skills"),
      path.join(item.env.HOME, ".kiro", "skills")
    ];
    for (const root of globalRoots) fs.mkdirSync(path.join(root, "handoff"), { recursive: true });
    const defaultResult = command(["migrate", "legacy-skills", "--apply"], item.env);
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    for (const root of globalRoots) assert.equal(fs.existsSync(path.join(root, "handoff")), false);

    const explicitRoot = path.join(item.env.HOME, ".kiro", "skills");
    fs.mkdirSync(path.join(explicitRoot, "review-code"), { recursive: true });
    const explicit = command(["migrate", "legacy-skills", "--target", "kiro", "--apply"], item.env);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(fs.existsSync(path.join(explicitRoot, "review-code")), false);

    const project = path.join(item.temporary, "project");
    const projectRoot = path.join(project, ".claude", "skills");
    fs.mkdirSync(path.join(projectRoot, "review-code"), { recursive: true });
    const scoped = command(["migrate", "legacy-skills", "--target", "claude", "--scope", "project", "--project", project, "--apply"], item.env);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.equal(fs.existsSync(path.join(projectRoot, "review-code")), false);

    const destination = path.join(item.temporary, "destination");
    fs.mkdirSync(path.join(destination, "review-code"), { recursive: true });
    const custom = command(["migrate", "legacy-skills", "--dest", destination, "--apply"], item.env);
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(fs.existsSync(path.join(destination, "review-code")), false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});
