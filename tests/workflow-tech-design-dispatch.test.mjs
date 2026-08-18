import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SEND_TIMEOUT_MS,
  main as dispatchDraft,
  readContract,
  sendOutputFrom,
  sendWaypost
} from "../skills/tech-design-workflow/scripts/send-design-draft-with-review-context.mjs";
import {
  artifactSha256,
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
  const args = [
    "--workdir", workdir,
    "--task-id", "design-task",
    "--requester-role", "requester",
    "--requester-session-id", "requester-1",
    "--author-session-id", "author-1",
    "--reviewer-session-id", "reviewer-1",
    "--session-host", "agent-deck",
    "--round", "1",
    "--max-review-rounds", "5",
    "--artifact-path", ".agent-artifacts/design-spec/author-1/r001.md",
    "--archive-branch", "main",
    "--from-address", "waypost/requester-1",
    "--author-to-address", "waypost/author-1",
    "--reviewer-to-address", "waypost/reviewer-1",
    "--contract-file", contractFile,
    "--json"
  ];
  return {
    workdir,
    contractFile,
    args,
    stateFile: path.join(workdir, ".agent-artifacts", "design-spec-dispatch", "design-task.lock", "state.json")
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

function writeCurrentArtifact(item, source) {
  const artifact = path.join(item.workdir, ".agent-artifacts", "design-spec", "author-1", "r001.md");
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, source);
  return artifact;
}

function reviewArgs(item) {
  return [
    "--workdir", item.workdir,
    "--lane-state", ".agent-artifacts/design-spec-dispatch/design-task.lock/state.json",
    "--json"
  ];
}

function downgradeLaneToV2(item, mutate = () => {}) {
  const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
  state.schema_version = 2;
  delete state.pruner_policy;
  delete state.review_gate;
  mutate(state);
  fs.writeFileSync(item.stateFile, `${JSON.stringify(state, null, 2)}\n`);
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
    () => ({ status: 0, stdout: '{"delivery_id":"d1"}', stderr: "", error: null, signal: null, timedOut: false })
  );
  assert.equal(sent.status, "sent");
});

test("initial dispatch writes minimal shared state and marks it ready before author notification", async () => {
  const item = fixture();
  const records = [];
  let stateDuringAuthor;
  try {
    const stdout = await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost: successfulWaypost(records, record => {
        if (actionFrom(record.body) === "design_spec_draft_requested") {
          stateDuringAuthor = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
        }
      })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(stateDuringAuthor.schema_version, 3);
    assert.equal(stateDuringAuthor.pruner_policy, "auto");
    assert.equal(stateDuringAuthor.review_gate, null);
    assert.equal(stateDuringAuthor.dispatch_ready, true);
    assert.equal(stateDuringAuthor.review_epoch, 0);
    assert.equal(stateDuringAuthor.correctness_epoch, null);
    assert.equal(stateDuringAuthor.prune_epoch, null);
    for (const removed of [
      "decision_revision", "correctness_request", "prune_request",
      "review_context_delivery_id", "review_context_message_id", "state"
    ]) assert.equal(removed in stateDuringAuthor, false, removed);
    const summary = JSON.parse(stdout);
    assert.equal(summary.status, "sent");
    assert.equal(summary.state_file, fs.realpathSync(item.stateFile));
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("enabled pruner receives context before author", async () => {
  const item = fixture();
  const records = [];
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_prune_context",
      "design_spec_draft_requested"
    ]);
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.pruner_session_id, "pruner-1");
    assert.equal(state.pruner_to_address, "waypost/pruner-1");
    assert.equal(state.pruner_policy, "always");
    assert.equal(state.dispatch_ready, true);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("partial failure retains simple not-ready state and the same command retries safely", async () => {
  const item = fixture();
  const firstRecords = [];
  try {
    await assert.rejects(
      dispatchDraft([
        ...item.args,
        "--pruner-session-id", "pruner-1",
        "--pruner-to-address", "waypost/pruner-1"
      ], {
        requireCommand() {},
        runWaypost(command, args, options) {
          const action = actionFrom(options.input);
          firstRecords.push(action);
          if (action === "design_prune_context") {
            return { status: 1, stdout: "", stderr: "pruner unavailable", error: null, signal: null, timedOut: false };
          }
          return successfulWaypost([])(command, args, options);
        }
      }),
      /pruner context send failed/
    );
    assert.deepEqual(firstRecords, ["design_spec_review_context", "design_prune_context"]);
    assert.equal(JSON.parse(fs.readFileSync(item.stateFile, "utf8")).dispatch_ready, false);

    const retryRecords = [];
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost(retryRecords) }));
    assert.deepEqual(retryRecords.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_prune_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(JSON.parse(fs.readFileSync(item.stateFile, "utf8")).dispatch_ready, true);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("rerunning a successful dispatch repeats idempotent notifications without rewriting state", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    const before = fs.readFileSync(item.stateFile, "utf8");
    const records = [];
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(fs.readFileSync(item.stateFile, "utf8"), before);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("setup retry accepts schema-v2 defaults without rewriting author-owned state", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    downgradeLaneToV2(item);
    const before = fs.readFileSync(item.stateFile, "utf8");
    const records = [];
    await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost: successfulWaypost(records)
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(fs.readFileSync(item.stateFile, "utf8"), before);
    await assert.rejects(
      dispatchDraft([...item.args, "--pruner-policy", "auto"], {
        requireCommand() {},
        runWaypost: successfulWaypost([])
      }),
      /different pruner_policy/
    );
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("setup retry can finish an incomplete schema-v2 context dispatch", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    downgradeLaneToV2(item, state => { state.dispatch_ready = false; });
    await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost: successfulWaypost([])
    }));
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.schema_version, 2);
    assert.equal(state.dispatch_ready, true);
    assert.equal("pruner_policy" in state, false);
    assert.equal("review_gate" in state, false);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("dispatcher never writes lane state after author notification starts", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost: successfulWaypost([], record => {
        if (actionFrom(record.body) !== "design_spec_draft_requested") return;
        const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
        state.review_epoch = 1;
        state.correctness_epoch = 1;
        fs.writeFileSync(item.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      })
    }));
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.review_epoch, 1);
    assert.equal(state.correctness_epoch, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("existing lane accepts a newer contract revision and notifies consumers to reread", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\n## Original Request\nBuild it safely.\n");
    const records = [];
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.match(records[0].body, /^Context Revision: 2$/m);
    assert.equal(JSON.parse(fs.readFileSync(item.stateFile, "utf8")).context_revision, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("new lanes require round one, initial contract revision, distinct roles, and exact artifact path", async () => {
  const checks = [
    { replace: ["--round", "2"], error: /--round must be 1/ },
    { replace: ["--artifact-path", ".agent-artifacts/design-spec/author-1/r002.md"], error: /must equal/ },
    { replace: ["--reviewer-session-id", "requester-1"], error: /session ids must be distinct/ },
    { replace: ["--reviewer-to-address", "waypost/requester-1"], error: /addresses must be distinct/ }
  ];
  for (const check of checks) {
    const item = fixture();
    try {
      const args = [...item.args];
      args[args.indexOf(check.replace[0]) + 1] = check.replace[1];
      await assert.rejects(dispatchDraft(args, { requireCommand() {}, runWaypost: successfulWaypost([]) }), check.error);
      assert.equal(fs.existsSync(item.stateFile), false);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }

  const item = fixture();
  try {
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\n## Original Request\nBuild it.\n");
    await assert.rejects(dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }), /new design lane requires Context Revision: 1/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial pruner policy rejects contradictory activation arguments", async () => {
  for (const { extra, error } of [
    {
      extra: ["--pruner-policy", "always"],
      error: /always requires pruner session and address/
    },
    {
      extra: [
        "--pruner-policy", "auto",
        "--pruner-session-id", "pruner-1",
        "--pruner-to-address", "waypost\/pruner-1"
      ],
      error: /auto must defer pruner creation/
    }
  ]) {
    const item = fixture();
    try {
      await assert.rejects(
        dispatchDraft([...item.args, ...extra], {
          requireCommand() {},
          runWaypost: successfulWaypost([])
        }),
        error
      );
      assert.equal(fs.existsSync(item.stateFile), false);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }
});

test("readContract rejects missing revision headers", () => {
  const item = fixture();
  try {
    fs.writeFileSync(item.contractFile, "## Original Request\nBuild it.\n");
    assert.throws(() => readContract(item.contractFile), /Context Revision: 1/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("workflow policy TOML layers user-friendly positive integer overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-workflow-policy-"));
  try {
    const defaults = path.join(directory, "defaults.toml");
    const override = path.join(directory, "override.toml");
    fs.writeFileSync(defaults, "[tech_design.pruner]\nmax_lines = 250\nmax_chars = 20000\n");
    fs.writeFileSync(override, "[tech_design.pruner]\nmax_lines = 300\n");
    assert.deepEqual(loadWorkflowPolicy({ paths: [defaults, override] }), { maxLines: 300, maxChars: 20000 });
    assert.deepEqual(parseWorkflowPolicyToml("[tech_design.pruner]\nmax_chars = 42\n"), { max_chars: 42 });
    assert.throws(
      () => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_words = 10\n"),
      /invalid assignment/
    );
    assert.throws(
      () => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_lines = 0\n"),
      /positive integer/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("design measurement counts nonempty lines and non-whitespace Unicode characters", () => {
  assert.deepEqual(measureDesign(" one \n\n二 三\n"), { lines: 2, chars: 5 });
  assert.equal(artifactSha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("review dispatch rejects a malformed project policy before changing lane state", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Small design\n");
    fs.writeFileSync(
      path.join(item.workdir, "workflow-policy.local.toml"),
      "[tech_design.pruner]\nmax_lines = 0\n"
    );
    await assert.rejects(
      dispatchReview(reviewArgs(item), {
        requireCommand() {},
        runWaypost: successfulWaypost([])
      }),
      /max_lines must be a positive integer/
    );
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.review_epoch, 0);
    assert.equal(state.review_gate, null);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch writes a gate and reuses its epoch on retry", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Small design\n\nDo one thing.\n");
    const records = [];
    const stdout = await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.review_epoch, 1);
    assert.equal(summary.review_gate.pruner_required, false);
    let state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.review_epoch, 1);
    assert.equal(state.correctness_epoch, 1);
    assert.equal(state.prune_epoch, null);
    assert.equal(state.review_gate.artifact, ".agent-artifacts/design-spec/author-1/r001.md");
    assert.match(state.review_gate.artifact_sha256, /^[0-9a-f]{64}$/);

    const retryRecords = [];
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(retryRecords),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.review_epoch, 1);
    assert.deepEqual(retryRecords.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch migrates a progressed schema-v2 lane and requires fresh digest-bound reports", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Existing design\n");
    downgradeLaneToV2(item, state => {
      state.review_epoch = 2;
      state.correctness_epoch = 2;
      state.correctness_report = { epoch: 2, decision: "SOUND", caveats: [], user_decisions: [] };
      state.acceptance = { round: 1, artifact: state.current_artifact };
    });

    const records = [];
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 1, maxChars: 1 })
    }));
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.schema_version, 3);
    assert.equal(state.pruner_policy, "never");
    assert.equal(state.review_epoch, 3);
    assert.equal(state.correctness_epoch, 3);
    assert.equal(state.correctness_report, null);
    assert.equal(state.acceptance, null);
    assert.match(state.review_gate.artifact_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("schema-v2 lanes with a pruner migrate to always and keep both review roles", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Existing pruned design\n");
    downgradeLaneToV2(item);
    const records = [];
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.schema_version, 3);
    assert.equal(state.pruner_policy, "always");
    assert.equal(state.prune_epoch, state.review_epoch);
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_requested",
      "design_prune_requested"
    ]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("gate verification rejects schema-v2 without mutating it", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Existing design\n");
    downgradeLaneToV2(item);
    const before = fs.readFileSync(item.stateFile, "utf8");
    await assert.rejects(
      dispatchReview([...reviewArgs(item), "--verify-gate"], {
        requireCommand() { throw new Error("Waypost must not be required"); }
      }),
      error => error.prefix === "REVIEW_GATE_INVALID" && error.exitCode === 3
    );
    assert.equal(fs.readFileSync(item.stateFile, "utf8"), before);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("byte-different artifacts with identical metrics cannot replace a gated round", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    const artifact = writeCurrentArtifact(item, "allow cache\n");
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost([]),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    const first = fs.readFileSync(item.stateFile, "utf8");

    fs.writeFileSync(artifact, "block queue\n");
    const records = [];
    await assert.rejects(
      dispatchReview(reviewArgs(item), {
        requireCommand() {},
        runWaypost: successfulWaypost(records),
        loadPolicy() { throw new Error("policy must not load after artifact mutation"); }
      }),
      error => error.prefix === "ARTIFACT_CHANGED" && error.exitCode === 3
    );
    assert.deepEqual(records, []);
    assert.equal(fs.readFileSync(item.stateFile, "utf8"), first);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("authority changes can create a new epoch when gated artifact bytes are unchanged", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "allow cache\n");
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost([]),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    const first = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    first.user_decisions.push({ question: "Cache policy?", answer: "Allow it." });
    fs.writeFileSync(item.stateFile, `${JSON.stringify(first, null, 2)}\n`);

    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost([]),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    const second = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(second.review_epoch, first.review_epoch + 1);
    assert.equal(second.review_gate.artifact_sha256, first.review_gate.artifact_sha256);
    assert.equal(second.review_gate.user_decision_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("gate verification detects post-dispatch artifact mutation without Waypost", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    const artifact = writeCurrentArtifact(item, "allow cache\n");
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost([]),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    const verified = await captureStdout(() => dispatchReview([
      ...reviewArgs(item),
      "--verify-gate"
    ], {
      requireCommand() { throw new Error("Waypost must not be required"); }
    }));
    assert.equal(JSON.parse(verified).status, "verified");

    fs.writeFileSync(artifact, "block queue\n");
    await assert.rejects(
      dispatchReview([...reviewArgs(item), "--verify-gate"], {
        requireCommand() { throw new Error("Waypost must not be required"); }
      }),
      error => error.prefix === "ARTIFACT_CHANGED" && error.exitCode === 3
    );
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch rejects symlinked lane-state and artifact parents", async () => {
  for (const target of ["lane", "artifact"]) {
    const item = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), `agentgear-design-${target}-external-`));
    try {
      await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
      const artifact = writeCurrentArtifact(item, "# Design\n");
      const source = target === "lane"
        ? path.join(item.workdir, ".agent-artifacts", "design-spec-dispatch")
        : path.dirname(artifact);
      const moved = path.join(external, path.basename(source));
      fs.renameSync(source, moved);
      fs.symlinkSync(moved, source, "dir");
      await assert.rejects(
        dispatchReview(reviewArgs(item), {
          requireCommand() {},
          runWaypost: successfulWaypost([]),
          loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
        }),
        /must not contain symlink components/
      );
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }
});

test("oversized auto design blocks all review work until a lazy pruner is supplied", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Design\n\nFirst material line.\nSecond material line.\n");
    const blockedRecords = [];
    await assert.rejects(
      dispatchReview(reviewArgs(item), {
        requireCommand() {},
        runWaypost: successfulWaypost(blockedRecords),
        loadPolicy: () => ({ maxLines: 3, maxChars: 1000 })
      }),
      error => error.prefix === "PRUNER_REQUIRED" && error.exitCode === 3
    );
    assert.deepEqual(blockedRecords, []);
    let state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.review_epoch, 0);
    assert.equal(state.review_gate, null);
    assert.equal(state.pruner_session_id, undefined);

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
      "design_spec_review_requested",
      "design_prune_requested"
    ]);
    state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.pruner_session_id, "pruner-1");
    assert.equal(state.review_gate.pruner_required, true);
    assert.equal(state.correctness_epoch, 1);
    assert.equal(state.prune_epoch, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("explicit never policy records an oversized gate without starting a pruner", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-policy", "never"
    ], { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeCurrentArtifact(item, "# Design\n\nLarge enough.\n");
    const records = [];
    await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 1, maxChars: 1 })
    }));
    const state = JSON.parse(fs.readFileSync(item.stateFile, "utf8"));
    assert.equal(state.pruner_policy, "never");
    assert.equal(state.review_gate.pruner_required, false);
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});
