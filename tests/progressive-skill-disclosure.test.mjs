import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listSkills, loadCatalog, resolveSelection, upstreamSkillEntries, validateCatalog } from "../cli/lib/catalog.mjs";
import { LEGACY_SKILL_NAMES, migrateLegacySkills } from "../cli/lib/legacy-skill-migration.mjs";
import { actionAliases, appendAgentGuidance, appendRuntimeGuidance, buildSkillContentIndex, decodeSimpleFrontmatterScalar, formatSkillText, listSkillSelectors, resolveSkillAddress, runtimeCommandDefinitions, validateActionTemplates, validateSkillContentIndex } from "../cli/lib/skill-content.mjs";
import { detectAgentProfiles, resolveAgentProfiles } from "../providers/agent-profiles.mjs";
import { codeGraphIndexReady, readyExternalCommands, resolveExternalCommand } from "../providers/external-commands.mjs";
import { purgeRetrievedUpstreamSkills, retrieveUpstreamSkill, retrievedSkillMaterializationRoot, upstreamSkillDigest } from "../cli/lib/upstreams.mjs";
import { actionHeader, loadActionProducerManifest } from "../skills/multi-agent-protocol/scripts/action-producer.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrySkills = [
  "assess-tech-design",
  "browse-web",
  "code-health-review",
  "commit-staged",
  "delegate-code-task",
  "delegate-task",
  "explain-for-me",
  "explore-defects",
  "fix-strategy",
  "handoff",
  "intent-framing",
  "refactor-review",
  "roundtable",
  "route-waypost-action",
  "search-files",
  "simplify-review",
  "tech-design-workflow"
];

test("simple frontmatter decoding preserves trailing quotes in plain scalars", () => {
  assert.equal(decodeSimpleFrontmatterScalar('Return "done"'), 'Return "done"');
  assert.equal(decodeSimpleFrontmatterScalar("Return 'done'"), "Return 'done'");
  assert.equal(decodeSimpleFrontmatterScalar('"handoff"'), "handoff");
  assert.equal(decodeSimpleFrontmatterScalar('"handoff'), null);
});

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

function command(argumentsList, env = {}, cwd = rootDir) {
  return childProcess.spawnSync(process.execPath, [path.join(rootDir, "bin", "agentgear.mjs"), ...argumentsList], {
    cwd,
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
    catalog: {
      skills: {
        skills: { [skill]: {} },
        upstreams: Object.fromEntries(Object.entries(upstreams).map(([name, source]) => [
          name,
          { skillPath: `skills/${name}`, ...source }
        ]))
      }
    }
  };
}

function writeAgentAppendix(item, { selector = "start", agent = "codex", body = "## For Codex only\n\nCodex guidance.\n" } = {}) {
  const filePath = path.join(item.temporary, "skills", "fixture", "references", `${selector}-${agent}.md`);
  fs.writeFileSync(filePath, [
    "---",
    `agent: ${agent}`,
    `append-to-selector: ${selector}`,
    "---",
    "",
    body
  ].join("\n"));
  return filePath;
}

function writeRuntimeAppendix(item, {
  selector = "start",
  command = "test-tool",
  body = `## Runtime guidance: ${command}\n\nCandidate guidance.\n`
} = {}) {
  const filePath = path.join(item.temporary, "skills", "fixture", "references", `${selector}-${command}.md`);
  fs.writeFileSync(filePath, [
    "---",
    `runtime-command: ${command}`,
    `append-to-selector: ${selector}`,
    "---",
    "",
    body
  ].join("\n"));
  return filePath;
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

test("agent profiles are detected from native environment hints and can be overridden for debugging", () => {
  assert.deepEqual(detectAgentProfiles({}), []);
  assert.deepEqual(detectAgentProfiles({ CODEX_THREAD_ID: "thread" }), []);
  assert.deepEqual(detectAgentProfiles({ CODEX_THREAD_ID: "thread", CODEX_SANDBOX: "workspace-write" }), ["codex"]);
  assert.deepEqual(detectAgentProfiles({ CODEX_THREAD_ID: "thread", CODEX_CI: "0" }), ["codex"]);
  assert.deepEqual(resolveAgentProfiles({ env: {}, override: "codex" }), ["codex"]);
  assert.deepEqual(resolveAgentProfiles({ env: { CODEX_THREAD_ID: "thread", CODEX_SANDBOX: "1" }, override: "generic" }), []);
  assert.throws(() => resolveAgentProfiles({ override: "not-real" }), /Unknown agent profile: not-real/);
});

test("agent appendices add guarded guidance without changing selector identity", () => {
  const item = contentIndexFixture();
  try {
    const slicePath = path.join(item.temporary, "skills", "fixture", "references", "slice.md");
    fs.writeFileSync(slicePath, fs.readFileSync(slicePath, "utf8").replace("# Slice\n", "# Slice  \n"));
    writeAgentAppendix(item, { body: "## For Codex only\n\nCodex guidance.  \n" });
    const index = buildSkillContentIndex(item.temporary, item.catalog);
    const base = resolveSkillAddress(index, "fixture");
    const generic = appendAgentGuidance(index, base, []);
    const codex = appendAgentGuidance(index, base, ["codex"]);

    assert.equal(generic, base);
    assert.equal(generic.body, "\n# Slice  \n");
    assert.equal(codex.owner, "fixture");
    assert.equal(codex.canonicalSelector, "start");
    assert.equal(codex.body, "\n# Slice  \n\n## For Codex only\n\nCodex guidance.  \n");
    assert.deepEqual(codex.agentAppendices, [{ agent: "codex" }]);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("agent appendices validate their target, profile, guard, and workflow isolation", () => {
  const cases = [
    {
      mutate(item) { writeAgentAppendix(item, { selector: "missing" }); },
      buildError: /Agent appendix targets an unknown selector: fixture\/missing/
    },
    {
      mutate(item) { writeAgentAppendix(item, { agent: "claude-code", body: "## For Claude Code only\n" }); },
      buildError: /Unsupported agent claude-code/
    },
    {
      mutate(item) { writeAgentAppendix(item, { body: "Codex guidance without a guard.\n" }); },
      validationError: /agent appendix must start with "## For Codex only"/
    },
    {
      mutate(item) { writeAgentAppendix(item, { body: "    ## For Codex only\n\nIndented code is not a guard.\n" }); },
      validationError: /agent appendix must start with "## For Codex only"/
    },
    {
      mutate(item) { writeAgentAppendix(item, { body: "\t## For Codex only\n\nTabbed code is not a guard.\n" }); },
      validationError: /agent appendix must start with "## For Codex only"/
    },
    {
      mutate(item) { writeAgentAppendix(item, { body: "## For Codex only\n\nAction: agent_specific\n" }); },
      validationError: /agent appendix cannot declare an Action header/
    }
  ];

  for (const itemCase of cases) {
    const item = contentIndexFixture();
    try {
      itemCase.mutate(item);
      if (itemCase.buildError) {
        assert.throws(() => buildSkillContentIndex(item.temporary, item.catalog), itemCase.buildError);
      } else {
        const errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
        assert.equal(errors.some(error => itemCase.validationError.test(error)), true, errors.join("\n"));
      }
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("agent appendix guards accept CommonMark heading indentation", () => {
  for (const indentation of ["", " ", "  ", "   "]) {
    const item = contentIndexFixture();
    try {
      writeAgentAppendix(item, { body: `${indentation}## For Codex only  \n\nGuidance.\n` });
      assert.deepEqual(validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog)), []);
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("runtime appendices compose independent advisory candidates", () => {
  const item = contentIndexFixture();
  item.catalog.skills.runtimeCommands = {
    "first-tool": {},
    codegraph: { readiness: "codegraph-index" }
  };
  try {
    writeRuntimeAppendix(item, { command: "codegraph" });
    writeRuntimeAppendix(item, { command: "first-tool" });
    const index = buildSkillContentIndex(item.temporary, item.catalog);
    const base = resolveSkillAddress(index, "fixture");
    const firstOnly = appendRuntimeGuidance(index, base, new Set(["first-tool"]));
    const both = appendRuntimeGuidance(index, base, new Set(["first-tool", "codegraph"]));

    assert.match(firstOnly.body, /Runtime guidance: first-tool/);
    assert.doesNotMatch(firstOnly.body, /Runtime guidance: codegraph/);
    assert.match(both.body, /Runtime guidance: first-tool/);
    assert.match(both.body, /Runtime guidance: codegraph/);
    const definitions = runtimeCommandDefinitions(index, [base]);
    assert.deepEqual(new Set(definitions.map(definition => definition.name)), new Set(["first-tool", "codegraph"]));
    assert.deepEqual(definitions.find(definition => definition.name === "codegraph"), {
      name: "codegraph",
      readiness: "codegraph-index"
    });
    assert.equal(appendRuntimeGuidance(index, base, new Set()), base);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("runtime appendices validate declarations, targets, guards, and workflow isolation", () => {
  const cases = [
    {
      mutate(item) { writeRuntimeAppendix(item, { command: "missing-tool" }); },
      buildError: /command missing-tool is not declared/
    },
    {
      mutate(item) { writeRuntimeAppendix(item, { selector: "missing" }); },
      buildError: /Runtime appendix targets an unknown selector: fixture\/missing/
    },
    {
      mutate(item) { writeRuntimeAppendix(item, { body: "Runtime guidance without a guard.\n" }); },
      validationError: /runtime appendix must start with "## Runtime guidance: test-tool"/
    },
    {
      mutate(item) { writeRuntimeAppendix(item, { body: "## Runtime guidance: test-tool\n\nAction: unsafe\n" }); },
      validationError: /runtime appendix cannot declare an Action header/
    },
    {
      mutate(item) { writeRuntimeAppendix(item, { body: "## Runtime guidance: test-tool\n\nFrom: duplicate\n" }); },
      validationError: /runtime appendix cannot declare a transport header/
    }
  ];

  for (const itemCase of cases) {
    const item = contentIndexFixture();
    item.catalog.skills.runtimeCommands = { "test-tool": {} };
    try {
      itemCase.mutate(item);
      if (itemCase.buildError) {
        assert.throws(() => buildSkillContentIndex(item.temporary, item.catalog), itemCase.buildError);
      } else {
        const errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
        assert.equal(errors.some(error => itemCase.validationError.test(error)), true, errors.join("\n"));
      }
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("runtime command catalog rejects malformed declarations and readiness", () => {
  const cases = [
    catalog => { catalog.skills.runtimeCommands = []; },
    catalog => { catalog.skills.runtimeCommands["agent-browser"] = "available"; },
    catalog => { catalog.skills.runtimeCommands["agent-browser"].extra = true; },
    catalog => { catalog.skills.runtimeCommands["agent-browser"].readiness = "not-real"; },
    catalog => { catalog.skills.runtimeCommands["agent-browser"].readiness = "codegraph-index"; },
    catalog => { delete catalog.skills.runtimeCommands.codegraph.readiness; },
    catalog => { catalog.skills.runtimeCommands["bad/name"] = {}; }
  ];
  for (const mutate of cases) {
    const catalog = structuredClone(loadCatalog(rootDir));
    mutate(catalog);
    assert.notDeepEqual(validateCatalog(rootDir, catalog), []);
  }
});

test("external command probes and CodeGraph requires a workspace index", () => {
  const temporary = path.join(os.tmpdir(), "agentgear-runtime-command-test-fixture");
  const bin = path.join(temporary, "bin");
  const workspace = path.join(temporary, "workspace", "nested");
  const agentBrowser = path.join(bin, "agent-browser");
  const executableFiles = new Set([agentBrowser, path.join(bin, "codegraph")]);
  const indexDirectories = new Set();
  const indexFiles = new Set();
  const env = { PATH: bin };
  const stat = filePath => {
    if (executableFiles.has(filePath) || indexFiles.has(filePath)) {
      return { isFile: () => true, isDirectory: () => false };
    }
    if (indexDirectories.has(filePath)) {
      return { isFile: () => false, isDirectory: () => true };
    }
    throw new Error("missing fixture path");
  };
  const access = filePath => {
    if (!executableFiles.has(filePath)) throw new Error("not executable");
  };
  const probeOptions = { env, stat, access };

  assert.equal(resolveExternalCommand("agent-browser", probeOptions), agentBrowser);
  assert.equal(resolveExternalCommand("../agent-browser", probeOptions), null);
  assert.equal(codeGraphIndexReady(workspace, { env, stat }), false);
  assert.deepEqual(
    readyExternalCommands(
      [{ name: "agent-browser" }, { name: "codegraph", readiness: "codegraph-index" }],
      { workdir: workspace, ...probeOptions }
    ),
    new Set(["agent-browser"])
  );

  const dataDirectory = path.join(temporary, "workspace", ".codegraph");
  indexDirectories.add(dataDirectory);
  assert.equal(codeGraphIndexReady(workspace, { env, stat }), false);
  indexFiles.add(path.join(dataDirectory, "codegraph.db"));
  assert.equal(codeGraphIndexReady(workspace, { env, stat }), true);
  assert.deepEqual(
    readyExternalCommands(
      [{ name: "codegraph", readiness: "codegraph-index" }],
      { workdir: workspace, ...probeOptions }
    ),
    new Set(["codegraph"])
  );

  indexDirectories.delete(dataDirectory);
  indexFiles.delete(path.join(dataDirectory, "codegraph.db"));
  const customDataDirectory = path.join(temporary, "workspace", ".codegraph-linux");
  indexDirectories.add(customDataDirectory);
  indexFiles.add(path.join(customDataDirectory, "codegraph.db"));
  assert.equal(codeGraphIndexReady(workspace, { env: { ...env, CODEGRAPH_DIR: ".codegraph-linux" }, stat }), true);
  assert.equal(codeGraphIndexReady(workspace, { env: { ...env, CODEGRAPH_DIR: " .codegraph-linux " }, stat }), true);
  assert.equal(codeGraphIndexReady(workspace, { env: { ...env, CODEGRAPH_DIR: "../outside" }, stat }), false);

  const embeddedDotsDirectory = path.join(temporary, "workspace", "foo..bar");
  indexDirectories.add(embeddedDotsDirectory);
  indexFiles.add(path.join(embeddedDotsDirectory, "codegraph.db"));
  assert.equal(codeGraphIndexReady(workspace, { env: { ...env, CODEGRAPH_DIR: "foo..bar" }, stat }), false);

  const spacedDataDirectory = path.join(temporary, "workspace", "bad name");
  indexDirectories.add(spacedDataDirectory);
  indexFiles.add(path.join(spacedDataDirectory, "codegraph.db"));
  assert.equal(codeGraphIndexReady(workspace, { env: { ...env, CODEGRAPH_DIR: "bad name" }, stat }), true);
});

test("external command probes honor Windows PATHEXT without executing candidates", () => {
  const executable = "C:\\Tools\\agent-browser.EXE";
  const stat = filePath => {
    if (filePath !== executable) throw new Error("missing fixture path");
    return { isFile: () => true };
  };
  const access = filePath => {
    if (filePath !== executable) throw new Error("not executable");
  };
  assert.equal(resolveExternalCommand("agent-browser", {
    env: { PATH: "C:\\Tools;relative", PATHEXT: ".exe;.cmd" },
    platform: "win32",
    stat,
    access
  }), executable);
});

test("browse-web and search-files append only ready advisory candidates", () => {
  const index = buildSkillContentIndex(rootDir, loadCatalog(rootDir));
  const browse = resolveSkillAddress(index, "browse-web");
  const browseBase = appendRuntimeGuidance(index, browse, new Set());
  const browseCandidate = appendRuntimeGuidance(index, browse, new Set(["agent-browser"]));
  assert.equal(browseBase, browse);
  assert.match(browseCandidate.body, /Runtime guidance: agent-browser/);
  assert.match(browseCandidate.body, /built-in browser capability/);
  assert.doesNotMatch(browseCandidate.body, /curl/i);

  const search = resolveSkillAddress(index, "search-files");
  const partial = appendRuntimeGuidance(index, search, new Set(["fd", "rg", "mq", "yq", "ast-grep"]));
  const complete = appendRuntimeGuidance(index, search, new Set(["fd", "rg", "mq", "yq", "ast-grep", "codegraph"]));
  assert.match(partial.body, /Runtime guidance: fd/);
  assert.match(partial.body, /Runtime guidance: rg/);
  assert.match(partial.body, /Runtime guidance: mq/);
  assert.match(partial.body, /Runtime guidance: yq/);
  assert.match(partial.body, /Runtime guidance: ast-grep/);
  assert.doesNotMatch(partial.body, /Runtime guidance: codegraph/);
  assert.match(complete.body, /Runtime guidance: codegraph/);
});

test("bootstrap validation rejects metadata duplicated into the body", () => {
  const item = contentIndexFixture();
  const skillFile = path.join(item.temporary, "skills", "fixture", "SKILL.md");
  const writeBootstrap = body => fs.writeFileSync(skillFile, [
    "---",
    "name: fixture",
    "description: Fixture description.",
    "---",
    "",
    body,
    ""
  ].join("\n"));
  try {
    writeBootstrap("Fixture description.");
    assert.throws(
      () => buildSkillContentIndex(item.temporary, item.catalog, { validateBootstraps: true }),
      /repeats its frontmatter description as its first body paragraph/
    );

    writeBootstrap("# fixture\n\nDistinct guidance.");
    assert.throws(
      () => buildSkillContentIndex(item.temporary, item.catalog, { validateBootstraps: true }),
      /repeats its frontmatter name as a heading/
    );

    writeBootstrap("Distinct guidance.");
    assert.doesNotThrow(() => buildSkillContentIndex(item.temporary, item.catalog, { validateBootstraps: true }));
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("skill text formatting preserves exact single and multi-selection framing", () => {
  const first = { requestedAddress: "alpha/start", body: "first\n\nsecond" };
  const second = { requestedAddress: "beta/end", body: "# Heading\nbody\n" };

  assert.equal(formatSkillText({ selections: [first] }), "first\n\nsecond\n");
  assert.equal(formatSkillText({ selections: [second, first, second] }), [
    "agentgear skill: beta/end",
    "  # Heading",
    "  body",
    "",
    "agentgear skill: alpha/start",
    "  first",
    "  ",
    "  second",
    "",
    "agentgear skill: beta/end",
    "  # Heading",
    "  body",
    ""
  ].join("\n"));
});

test("catalog exposes exactly the approved entry surface", () => {
  const catalog = loadCatalog(rootDir);
  const all = resolveSelection(catalog, { packs: ["all"] });
  assert.deepEqual([...all.exposedSkills].sort(), entrySkills);
  assert.equal(catalog.skills.skills["dispatch-plan"], undefined);
  assert.equal(all.capabilitySkills.includes("dispatch-plan"), false);
  assert.deepEqual(resolveSelection(catalog, { packs: ["core"] }).exposedSkills.sort(), entrySkills.filter(skill => [
    "assess-tech-design", "browse-web", "commit-staged", "explain-for-me", "explore-defects", "fix-strategy", "handoff", "search-files"
  ].includes(skill)));
  assert.equal(all.exposedSkills.includes("agent-deck"), false);
});

test("upstream public skill names are independent from internal identifiers and cannot collide", () => {
  const catalog = structuredClone(loadCatalog(rootDir));
  const source = catalog.skills.upstreams["agent-deck"];
  delete catalog.skills.upstreams["agent-deck"];
  catalog.skills.upstreams.documentationSource = source;
  catalog.skills.sessionHosts["agent-deck"].upstream = "documentationSource";

  assert.deepEqual(validateCatalog(rootDir, catalog), []);
  assert.deepEqual(upstreamSkillEntries(catalog).map(entry => ({
    upstream: entry.upstream,
    name: entry.name
  })), [{ upstream: "documentationSource", name: "agent-deck" }]);
  const listed = listSkills(catalog).filter(skill => skill.kind === "upstream");
  assert.deepEqual(listed.map(skill => ({ name: skill.name, upstream: skill.upstream })), [
    { name: "agent-deck", upstream: "documentationSource" }
  ]);
  const index = buildSkillContentIndex(rootDir, catalog);
  assert.equal(index.upstreamEntryAddresses.has("agent-deck"), true);
  assert.equal(index.upstreamEntryAddresses.has("documentationSource"), false);

  const duplicate = structuredClone(catalog);
  duplicate.skills.upstreams.secondSource = { ...source, skillPath: "vendor/agent-deck" };
  assert.equal(validateCatalog(rootDir, duplicate).some(error =>
    /upstreams documentationSource and secondSource expose duplicate skill name: agent-deck/.test(error)), true);

  const canonicalCollision = structuredClone(catalog);
  canonicalCollision.skills.upstreams.documentationSource.skillPath = "skills/review-code";
  assert.equal(validateCatalog(rootDir, canonicalCollision).some(error =>
    /upstream documentationSource exposes canonical skill name: review-code/.test(error)), true);
});

test("plan dispatch is an internal protocol selector rather than a skill", () => {
  const internal = command(["skill", "get", "multi-agent-protocol/internal/dispatch-plan"]);
  assert.equal(internal.status, 0, internal.stderr);
  assert.match(internal.stdout, /# Dispatch Plan/);

  const direct = command(["skill", "get", "dispatch-plan"]);
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /Unknown skill address: dispatch-plan/);
});

test("refactor review requests use an internal selector rather than a skill", () => {
  const catalog = loadCatalog(rootDir);
  const all = resolveSelection(catalog, { packs: ["all"] });
  assert.equal(catalog.skills.skills["refactor-review-request"], undefined);
  assert.equal(all.capabilitySkills.includes("refactor-review-request"), false);

  const internal = command(["skill", "get", "refactor-review/internal/request"]);
  assert.equal(internal.status, 0, internal.stderr);
  assert.match(internal.stdout, /# Refactor Review Request/);

  const direct = command(["skill", "get", "refactor-review-request"]);
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /Unknown skill address: refactor-review-request/);
});

test("skill help states the stable guidance policy once", () => {
  const result = command(["skill", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /skill get[^\n]*--json/);
  assert.doesNotMatch(result.stdout, /skill get[^\n]*\[--\]/);
  assert.match(result.stdout, /skill list \[--json\]/);
  assert.match(result.stdout, /agentgear skill get action:review_requested/);
  assert.match(result.stdout, /Remember and reuse skill text unless its bootstrap states a refresh boundary\./);
});

test("route-waypost-action loads the registered instructions for an Action field", () => {
  const bootstrap = fs.readFileSync(path.join(rootDir, "skills", "route-waypost-action", "SKILL.md"), "utf8");
  assert.match(bootstrap, /Agentgear/);
  assert.match(bootstrap, /skill get/);
  assert.match(bootstrap, /action:<value>/);
  assert.doesNotMatch(bootstrap, /agentgear skill get route-waypost-action/);

  const result = command(["skill", "get", "route-waypost-action"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Route Waypost Action/);
  assert.match(result.stdout, /Agentgear/);
  assert.match(result.stdout, /skill get/);
  assert.match(result.stdout, /action:<value>/);
  assert.doesNotMatch(result.stdout, /validat|malformed|case-insensitive/i);
  assert.doesNotMatch(result.stdout, /waypost_recv/);
});

test("receiver and rejection handlers settle routing and authentication failures", () => {
  const receiver = fs.readFileSync(path.join(
    rootDir,
    "skills",
    "multi-agent-protocol",
    "references",
    "internal-protocol",
    "shared-protocol.md"
  ), "utf8");
  assert.match(receiver, /Action lookup or another routing step fails/);
  assert.doesNotMatch(receiver, /malformed or unknown Action is rejected/);

  const rejected = command(["skill", "get", "action:message_rejected"]);
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stdout, /Missing or ambiguous history: defer the claim/);
  assert.match(rejected.stdout, /Endpoint mismatch: fail it/);
  assert.match(rejected.stdout, /Acknowledge a matching rejection/);
});

test("skill get resolves independent addresses, global fallbacks, and atomic errors", () => {
  const index = buildSkillContentIndex(rootDir, loadCatalog(rootDir));
  const entry = command(["skill", "get", "handoff"]);
  assert.equal(entry.status, 0, entry.stderr);
  assert.equal(entry.stdout.trim(), resolveSkillAddress(index, "handoff").body.trim());

  const entryWithoutCandidates = command(["skill", "get", "handoff"], { PATH: "" });
  const entryWithUnrelatedPath = command(["skill", "get", "handoff"], { PATH: "/unavailable-runtime-tools" });
  assert.equal(entryWithoutCandidates.stdout, entryWithUnrelatedPath.stdout);
  assert.equal(entryWithoutCandidates.stdout, entry.stdout);

  const alias = command(["skill", "get", "action:execute_delegate_task"]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.equal(alias.stdout.trim(), resolveSkillAddress(index, "action:execute_delegate_task").body.trim());

  const fallback = command(["skill", "get", "session-host"]);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout.trim(), resolveSkillAddress(index, "session-host").body.trim());

  const multi = command(["skill", "get", "action:group_message_available", "tech-design-workflow/report-handling"]);
  assert.equal(multi.status, 0, multi.stderr);
  assert.match(multi.stdout, /^agentgear skill: action:group_message_available/m);
  assert.match(multi.stdout, /^agentgear skill: tech-design-workflow\/report-handling/m);

  const ambiguous = command(["skill", "get", "continue-1"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /Ambiguous skill address continue-1/);

  const unknown = command(["skill", "get", "action:group_message_available", "not-real"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown skill address: not-real/);
  assert.match(unknown.stderr, /agentgear skill list/);
  assert.doesNotMatch(unknown.stderr, /skill list SKILL/);

  const actionTypo = command(["skill", "get", "action:review-request"]);
  assert.equal(actionTypo.status, 2);
  assert.match(actionTypo.stderr, /agentgear skill get action:review_requested/);

  const wrongOwner = command(["skill", "get", "delegate-code-task/review-request"]);
  assert.equal(wrongOwner.status, 2);
  assert.match(wrongOwner.stderr, /agentgear skill get review-request\/request/);
  assert.match(wrongOwner.stderr, /agentgear skill list delegate-code-task/);
});

test("skill list is deterministic and emits directly resolvable owned addresses", () => {
  const all = command(["skill", "list"]);
  assert.equal(all.status, 0, all.stderr);
  const names = all.stdout.trim().split("\n");
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes("agent-deck"));
  assert.ok(names.includes("review-code"));

  const allJson = command(["skill", "list", "--json"]);
  assert.equal(allJson.status, 0, allJson.stderr);
  assert.deepEqual(JSON.parse(allJson.stdout).map(record => record.name), names);

  const result = command(["skill", "list", "route-waypost-action", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout);
  const selectors = records.map(record => record.selector);
  assert.deepEqual(selectors, [...selectors].sort());
  assert.ok(selectors.includes("action:group_message_available"));
  assert.ok(selectors.includes("route-waypost-action/group-route"));

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
    assert.equal(errors.some(error => /Unknown skill address: agent-deck\/not-real/.test(error)), true);

    for (const addresses of ["agent-deck fixture/start", "fixture/start agent-deck"]) {
      fs.writeFileSync(overviewPath, `Run \`agentgear skill get ${addresses}\`.\n`);
      errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
      assert.equal(errors.some(error => /Upstream skill agent-deck cannot be combined with other addresses/.test(error)), true);
    }
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("selector validation rejects Markdown fences that leak into another slice", () => {
  const item = contentIndexFixture();
  const selectorPath = path.join(item.temporary, "skills", "fixture", "references", "slice.md");
  try {
    fs.appendFileSync(selectorPath, "\n```markdown\nAction: fixture_action\n");
    const errors = validateSkillContentIndex(buildSkillContentIndex(item.temporary, item.catalog));
    assert.equal(errors.some(error => /unclosed Markdown fence; each selector must be self-contained/.test(error)), true);
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
  assert.equal(skills.filter(skill => skill.kind === "canonical").length, 29);

  const text = command(["list"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Upstream retrievable skills: agent-deck/);
  assert.match(text.stdout, /Skills \(29\)/);
});

test("upstream skill get returns a usable base directory from a verified runtime and rejects selectors", () => {
  const item = fixture();
  try {
    const runtime = path.join(item.env.XDG_DATA_HOME, "agentgear", "current");
    fs.cpSync(rootDir, runtime, {
      recursive: true,
      filter: source => ![".git", "dist", "node_modules"].includes(path.basename(source))
        && !path.basename(source).startsWith(".dist-")
    });
    const source = path.join(runtime, "catalog", "skills.json");
    const catalog = JSON.parse(fs.readFileSync(source, "utf8"));
    const upstream = catalog.upstreams["agent-deck"];
    delete catalog.upstreams["agent-deck"];
    catalog.upstreams.documentationSource = upstream;
    catalog.sessionHosts["agent-deck"].upstream = "documentationSource";
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
    const listed = runtimeCommand(["skill", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim().split("\n").includes("agent-deck"), true);
    assert.equal(listed.stdout.includes("documentationSource"), false);
    const selectors = runtimeCommand(["skill", "list", "agent-deck", "--json"]);
    assert.equal(selectors.status, 0, selectors.stderr);
    assert.deepEqual(JSON.parse(selectors.stdout), []);
    const text = runtimeCommand(["skill", "get", "agent-deck"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^Base directory for this skill: /);
    assert.match(text.stdout, /# Agent Deck/);
    const resourceBase = /^Base directory for this skill: (.+)$/m.exec(text.stdout)?.[1];
    assert.equal(path.isAbsolute(resourceBase), true);
    assert.equal(fs.readFileSync(path.join(resourceBase, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal(fs.existsSync(path.join(item.env.HOME, ".agents", "skills", "agent-deck")), false);
    assert.equal(fs.existsSync(path.join(item.env.XDG_STATE_HOME, "agentgear", "installs.json")), false);
    const unknown = runtimeCommand(["skill", "get", "agent-deck/not-real"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stdout, "");
    const internalIdentifier = runtimeCommand(["skill", "get", "documentationSource"]);
    assert.equal(internalIdentifier.status, 2);
    assert.equal(internalIdentifier.stdout, "");
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
        && !path.basename(sourcePath).startsWith(".dist-")
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

test("action aliases are complete, direct, and selector validation resolves multi-selector references", () => {
  const catalog = loadCatalog(rootDir);
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  assert.deepEqual(validateSkillContentIndex(index), []);
  const aliases = actionAliases(index);
  const expected = [
    "abort_iteration", "browser_check_report", "browser_check_requested", "browser_setup_provided", "browser_setup_requested",
    "closeout_delivered", "code_delivery_complete", "code_health_review_report", "code_health_review_requested",
    "delegated_task_result", "design_prune_context", "design_prune_report", "design_prune_requested",
    "design_spec_delivered", "design_spec_draft_requested",
    "design_spec_review_context", "design_spec_review_context_rejected",
    "design_spec_review_report", "design_spec_review_requested",
    "execute_delegate_task", "execute_delegated_task", "execute_plan", "group_message_available",
    "intent_framer_turn", "intent_framer_update", "message_rejected",
    "plan_report_delivered", "refactor_review_report", "refactor_review_requested", "review_requested",
    "review_task_context", "rework_required", "roundtable_participant_turn", "simplify_review_report",
    "simplify_review_requested", "work_accepted"
  ];
  assert.deepEqual([...aliases.keys()].sort(), expected);
  const requestedAddresses = expected.map(token => `action:${token}`);
  const result = command(["skill", "get", "--", ...requestedAddresses]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...result.stdout.matchAll(/^agentgear skill: (.+)$/gm)].map(match => match[1]),
    requestedAddresses
  );
  const discriminatorTokens = new Set([
    "browser_check_report", "design_spec_review_requested",
    "group_message_available",
    "rework_required", "work_accepted", "abort_iteration"
  ]);
  for (const token of expected) {
    if (discriminatorTokens.has(token)) continue;
    const record = aliases.get(token);
    const canonical = `${record.owner}/${record.selector}`;
    assert.equal(index.byCanonicalAddress.get(canonical), record, `${token} must directly own ${canonical}`);
  }
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

  for (const header of ["From", "To", "  fRoM", "\tto"]) {
    const transportIndex = {
      ...index,
      byCanonicalAddress: new Map([["fixture/transport", {
        ...staticRecord,
        filePath: path.join(rootDir, "skills", "fixture", "references", "transport.md"),
        body: `\`\`\`markdown\nAction: review_requested\n${header}: session-1\n\`\`\`\n`
      }]])
    };
    assert.equal(validateActionTemplates(transportIndex, aliases).some(error => error.toLowerCase().includes(`${header.trim().toLowerCase()} duplicates waypost transport metadata`)), true);
  }

  for (const body of [
    "```markdown\n  Action: ${runtimeValue}\n```\n",
    "```markdown\nAction: <action>\n```\n",
    "```markdown\nAction: review_requested | work_accepted\n```\n",
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
  for (const name of ["From", "To", "fRoM", "tO"]) {
    assert.throws(() => declarations.factories.REVIEW_TASK_CONTEXT({
      before: [{ name, value: "session-1" }], after: [], body: "body"
    }), /may not duplicate transport/);
  }
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
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-action-template-test-"));
  const checkout = path.join(temporary, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  for (const directory of ["catalog", "skills"]) {
    fs.cpSync(path.join(rootDir, directory), path.join(checkout, directory), { recursive: true });
  }
  const catalog = loadCatalog(checkout);
  const index = buildSkillContentIndex(checkout, catalog, { validateBootstraps: true });
  const aliases = actionAliases(index);
  const declaration = path.join(checkout, "skills", "multi-agent-protocol", "action-producers.json");
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
    fs.writeFileSync(path.join(checkout, "skills", "multi-agent-protocol", "scripts", "producer-fixture.mjs"), cleanProducerSyntax);
    const cleanIndex = buildSkillContentIndex(checkout, catalog, { validateBootstraps: true });
    assert.deepEqual(validateActionTemplates(cleanIndex, aliases), []);

    const invalid = JSON.parse(original);
    invalid.actions.REVIEW_TASK_CONTEXT.token = "not_registered";
    fs.writeFileSync(declaration, `${JSON.stringify(invalid, null, 2)}\n`);
    const invalidIndex = buildSkillContentIndex(checkout, catalog, { validateBootstraps: true });
    assert.equal(validateActionTemplates(invalidIndex, aliases).some(error => /action-producers\.json: unregistered Action token not_registered/.test(error)), true);

    const missingBoundary = JSON.parse(original);
    missingBoundary.actions.REVIEW_TASK_CONTEXT.script = "producer-fixture.mjs";
    fs.writeFileSync(declaration, `${JSON.stringify(missingBoundary, null, 2)}\n`);
    const boundaryIndex = buildSkillContentIndex(checkout, catalog, { validateBootstraps: true });
    assert.equal(validateActionTemplates(boundaryIndex, aliases).some(error => /Action producer script does not reference declared factory reviewTaskContextMessage/.test(error)), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
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
      path.join(rootDir, "skills", "tech-design-workflow", "scripts", "dispatch-design-review.mjs"),
      ["design_spec_review_requested", "design_prune_requested"]
    ],
    [
      path.join(rootDir, "skills", "tech-design-workflow", "scripts", "send-design-draft-with-review-context.mjs"),
      ["design_prune_context", "design_spec_review_context", "design_spec_draft_requested"]
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
  assert.match(skill.stderr, /skill get accepts only/);
  const jsonGet = command(["skill", "get", "--json", "handoff"]);
  assert.equal(jsonGet.status, 1);
  assert.equal(jsonGet.stdout, "");
  assert.match(jsonGet.stderr, /skill get does not support --json; output is always text/);
  const listThroughGet = command(["skill", "get", "--list"]);
  assert.equal(listThroughGet.status, 1);
  assert.match(listThroughGet.stderr, /use `agentgear skill list`/);
  const debugOverride = command(["skill", "get", "--agent-profile", "generic", "handoff"]);
  assert.equal(debugOverride.status, 0, debugOverride.stderr);
  const unknownProfile = command(["skill", "get", "--agent-profile", "not-real", "handoff"]);
  assert.equal(unknownProfile.status, 1);
  assert.match(unknownProfile.stderr, /Unknown agent profile: not-real/);
  const listProfile = command(["skill", "list", "--agent-profile", "codex", "handoff"]);
  assert.equal(listProfile.status, 1);
  assert.match(listProfile.stderr, /only valid with skill get/);
  for (const argumentsList of [
    ["list", "--agent-profile", "generic"],
    ["install", "--agent-profile", "generic"],
    ["update", "--agent-profile", "generic"],
    ["migrate", "legacy-skills", "--agent-profile", "generic"]
  ]) {
    const rejected = command(argumentsList);
    assert.equal(rejected.status, 1, argumentsList.join(" "));
    assert.match(rejected.stderr, /Unknown option: --agent-profile/);
  }
  const sourceInstallProfile = childProcess.spawnSync(
    process.execPath,
    [path.join(rootDir, "bin", "agentgear-source-install.mjs"), "--agent-profile", "generic"],
    { cwd: rootDir, env: process.env, encoding: "utf8" }
  );
  assert.equal(sourceInstallProfile.status, 1);
  assert.match(sourceInstallProfile.stderr, /Unknown option: --agent-profile/);
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
    "assess-tech-design", "browse-web", "commit-staged", "explain-for-me", "explore-defects", "fix-strategy", "handoff", "search-files"
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
