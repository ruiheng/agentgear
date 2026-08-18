import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SEND_TIMEOUT_MS,
  expectedArtifactPath,
  main as dispatchDraft,
  readContract,
  sendOutputFrom,
  sendWaypost
} from "../skills/tech-design-workflow/scripts/send-design-draft-with-review-context.mjs";
import {
  main as dispatchReview,
  measureDesign
} from "../skills/tech-design-workflow/scripts/dispatch-design-review.mjs";
import {
  loadWorkflowPolicy,
  parseWorkflowPolicyToml
} from "../skills/tech-design-workflow/scripts/workflow-policy.mjs";

function fixture() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const messageDir = path.join(workdir, ".agent-artifacts", "message");
  fs.mkdirSync(messageDir, { recursive: true });
  const contractFile = path.join(messageDir, "task.md");
  fs.writeFileSync(contractFile, "Context Revision: 1\n\n## Original Request\nBuild it.\n");
  const manifestRelative = ".agent-artifacts/design-spec-dispatch/design-task.lock/lane.json";
  return {
    workdir,
    contractFile,
    manifestRelative,
    manifestFile: path.join(workdir, manifestRelative),
    args: [
      "--workdir", workdir,
      "--task-id", "design-task",
      "--requester-session-id", "requester-1",
      "--author-session-id", "author-1",
      "--reviewer-session-id", "reviewer-1",
      "--session-host", "agent-deck",
      "--max-review-rounds", "5",
      "--archive-branch", "main",
      "--from-address", "waypost/requester-1",
      "--author-to-address", "waypost/author-1",
      "--reviewer-to-address", "waypost/reviewer-1",
      "--contract-file", contractFile,
      "--json"
    ]
  };
}

function actionFrom(body) {
  return /^Action: ([^\n]+)$/m.exec(body)?.[1];
}

function successfulWaypost(records, hook) {
  let sequence = 0;
  return (command, args, options) => {
    sequence += 1;
    const record = { command, args, body: options.input };
    records.push(record);
    hook?.(record, sequence);
    return {
      status: 0,
      stdout: JSON.stringify({
        delivery_id: `delivery-${sequence}`,
        message_id: `message-${sequence}`,
        notify_status: "notified",
        notify_scheme: "test"
      }),
      stderr: "",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function writeArtifact(item, round, source) {
  const relative = expectedArtifactPath("author-1", round);
  const artifact = path.join(item.workdir, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, source);
  return { relative, artifact };
}

function reviewArgs(item, round = 1) {
  return [
    "--workdir", item.workdir,
    "--lane-manifest", item.manifestRelative,
    "--artifact", expectedArtifactPath("author-1", round),
    ...(round > 1 ? ["--previous-artifact", expectedArtifactPath("author-1", round - 1)] : []),
    "--round", String(round),
    "--context-revision", "1",
    "--json"
  ];
}

async function createLane(item, records = []) {
  await captureStdout(() => dispatchDraft(item.args, {
    requireCommand() {},
    runWaypost: successfulWaypost(records)
  }));
}

async function captureStdout(action) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("send parsing keeps delivery receipts as transport results", () => {
  assert.equal(DEFAULT_SEND_TIMEOUT_MS, 0);
  assert.deepEqual(sendOutputFrom(JSON.stringify({ delivery_id: "d1" })).receipt, { delivery_id: "d1" });
  const sent = sendWaypost(
    (message, options) => options.runCommand("waypost", ["send"], { input: message }),
    { fromAddress: "from", contentType: "text/markdown", schemaVersion: "1", sendTimeoutMs: 0 },
    "to", "subject", "body",
    () => ({ status: 0, stdout: "{\"delivery_id\":\"d1\"}", stderr: "", error: null, signal: null, timedOut: false })
  );
  assert.equal(sent.status, "sent");
});

test("initial dispatch writes one stable manifest and notifies reviewer before author", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item, records);
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    const manifest = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.pruner_policy, "auto");
    assert.equal(manifest.context_file, ".agent-artifacts/message/task.md");
    assert.equal(manifest.max_review_rounds, 5);
    for (const dynamic of [
      "current_round", "current_artifact", "previous_artifact", "review_epoch",
      "correctness_report", "prune_report", "review_gate", "acceptance",
      "dispatch_ready", "artifact_sha256"
    ]) assert.equal(dynamic in manifest, false, dynamic);
    assert.match(records[1].body, /^Artifact: \.agent-artifacts\/design-spec\/author-1\/r001\.md$/m);
    assert.equal(fs.statSync(item.manifestFile).isFile(), true);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("always policy records and initializes one pruner", async () => {
  const item = fixture();
  const records = [];
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context", "design_prune_context", "design_spec_draft_requested"
    ]);
    const manifest = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    assert.equal(manifest.pruner_policy, "always");
    assert.equal(manifest.pruner_session_id, "pruner-1");
    assert.equal(manifest.pruner_to_address, "waypost/pruner-1");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("setup retry preserves manifest bytes and repeats idempotent notifications", async () => {
  const item = fixture();
  try {
    await createLane(item);
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const records = [];
    await createLane(item, records);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context", "design_spec_draft_requested"
    ]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("partial notification failure leaves only the immutable manifest for retry", async () => {
  const item = fixture();
  try {
    await assert.rejects(
      dispatchDraft(item.args, {
        requireCommand() {},
        runWaypost(command, args, options) {
          if (actionFrom(options.input) === "design_spec_draft_requested") {
            return { status: 1, stdout: "", stderr: "author unavailable", error: null, signal: null, timedOut: false };
          }
          return successfulWaypost([])(command, args, options);
        }
      }),
      /author draft send failed/
    );
    const before = fs.readFileSync(item.manifestFile, "utf8");
    await createLane(item);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch rejects contradictory pruner policy and unsafe lane parents", async () => {
  for (const { extra, error } of [
    { extra: ["--pruner-policy", "always"], error: /always requires pruner session and address/ },
    {
      extra: ["--pruner-policy", "auto", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost\/pruner-1"],
      error: /auto must defer pruner creation/
    },
    {
      extra: ["--pruner-policy", "never", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost\/pruner-1"],
      error: /never cannot include a pruner session/
    }
  ]) {
    const item = fixture();
    try {
      await assert.rejects(dispatchDraft([...item.args, ...extra], {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }), error);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }

  const item = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-lane-external-"));
  try {
    fs.mkdirSync(path.join(item.workdir, ".agent-artifacts"), { recursive: true });
    fs.symlinkSync(external, path.join(item.workdir, ".agent-artifacts", "design-spec-dispatch"), "dir");
    await assert.rejects(dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }), /must not contain symlink components/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("new lanes require initial contract revision and distinct participant identities", async () => {
  const item = fixture();
  try {
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\nBuild it.\n");
    await assert.rejects(dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }), /new design lane requires Context Revision: 1/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }

  for (const [flag, value, error] of [
    ["--reviewer-session-id", "requester-1", /session ids must be distinct/],
    ["--reviewer-to-address", "waypost\/requester-1", /addresses must be distinct/]
  ]) {
    const lane = fixture();
    try {
      const args = [...lane.args];
      args[args.indexOf(flag) + 1] = value;
      await assert.rejects(dispatchDraft(args, {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }), error);
    } finally {
      fs.rmSync(lane.workdir, { recursive: true, force: true });
    }
  }
});

test("contract parser and TOML policy enforce simple human-editable inputs", () => {
  const item = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-workflow-policy-"));
  try {
    fs.writeFileSync(item.contractFile, "## Original Request\nBuild it.\n");
    assert.throws(() => readContract(item.contractFile), /Context Revision: 1/);

    const defaults = path.join(directory, "defaults.toml");
    const override = path.join(directory, "override.toml");
    fs.writeFileSync(defaults, "[tech_design.pruner]\nmax_lines = 250\nmax_chars = 20000\n");
    fs.writeFileSync(override, "[tech_design.pruner]\nmax_lines = 300\n");
    assert.deepEqual(loadWorkflowPolicy({ paths: [defaults, override] }), { maxLines: 300, maxChars: 20000 });
    assert.deepEqual(parseWorkflowPolicyToml("[tech_design.pruner]\nmax_chars = 42\n"), { max_chars: 42 });
    assert.throws(() => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_words = 10\n"), /invalid assignment/);
    assert.throws(() => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_lines = 0\n"), /positive integer/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("design measurement counts nonempty lines and non-whitespace Unicode characters", () => {
  assert.deepEqual(measureDesign(" one \n\n二 三\n"), { lines: 2, chars: 5 });
});

test("below-threshold review dispatch sends only reviewer and never changes manifest", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Small design\n\nDo one thing.\n");
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const stdout = await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    assert.doesNotMatch(records[0].body, /SHA|Epoch|Gate/);
    assert.deepEqual(JSON.parse(stdout), {
      status: "sent", artifact: expectedArtifactPath("author-1", 1), round: 1,
      lines: 2, chars: 23, pruner_requested: false
    });
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("auto policy blocks before sending until an oversized design has a lazy pruner", async () => {
  const item = fixture();
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Design\n\nFirst material line.\nSecond material line.\n");
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const blocked = [];
    await assert.rejects(dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(blocked),
      loadPolicy: () => ({ maxLines: 3, maxChars: 1000 })
    }), error => error.prefix === "PRUNER_REQUIRED" && error.exitCode === 3);
    assert.deepEqual(blocked, []);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);

    const records = [];
    await captureStdout(() => dispatchReview([
      ...reviewArgs(item),
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 3, maxChars: 1000 })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    for (const record of records) assert.doesNotMatch(record.body, /SHA|Epoch|Gate/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("always and never policies deterministically override the threshold", async () => {
  for (const policy of ["always", "never"]) {
    const item = fixture();
    const records = [];
    try {
      const prunerArgs = policy === "always"
        ? ["--pruner-policy", "always", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost/pruner-1"]
        : ["--pruner-policy", "never"];
      await captureStdout(() => dispatchDraft([...item.args, ...prunerArgs], {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }));
      writeArtifact(item, 1, "# Design\n");
      await captureStdout(() => dispatchReview(reviewArgs(item), {
        requireCommand() {},
        runWaypost: successfulWaypost(records),
        loadPolicy: () => ({ maxLines: 1, maxChars: 1 })
      }));
      assert.deepEqual(records.map(record => actionFrom(record.body)), policy === "always"
        ? ["design_spec_review_requested", "design_prune_requested"]
        : ["design_spec_review_requested"]);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }
});

test("review dispatch validates exact round, previous artifact, and contract revision", async () => {
  const item = fixture();
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Round one\n");
    writeArtifact(item, 2, "# Round two\n");
    const wrongPrevious = reviewArgs(item, 2);
    wrongPrevious[wrongPrevious.indexOf("--previous-artifact") + 1] = expectedArtifactPath("author-1", 0);
    await assert.rejects(dispatchReview(wrongPrevious, {
      requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), /--previous-artifact must equal/);

    const wrongRevision = reviewArgs(item, 2);
    wrongRevision[wrongRevision.indexOf("--context-revision") + 1] = "2";
    await assert.rejects(dispatchReview(wrongRevision, {
      requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), /does not match the Canonical Contract/);

    const records = [];
    await captureStdout(() => dispatchReview(reviewArgs(item, 2), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    assert.match(records[0].body, /^Previous Artifact: \.agent-artifacts\/design-spec\/author-1\/r001\.md$/m);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch rejects symlinked manifest and artifact parents", async () => {
  for (const target of ["manifest", "artifact"]) {
    const item = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), `agentgear-design-${target}-external-`));
    try {
      await createLane(item);
      const { artifact } = writeArtifact(item, 1, "# Design\n");
      const source = target === "manifest"
        ? path.join(item.workdir, ".agent-artifacts", "design-spec-dispatch")
        : path.dirname(artifact);
      const moved = path.join(external, path.basename(source));
      fs.renameSync(source, moved);
      fs.symlinkSync(moved, source, "dir");
      await assert.rejects(dispatchReview(reviewArgs(item), {
        requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
      }), /must not contain symlink components/);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }
});
