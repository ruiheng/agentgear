import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SEND_TIMEOUT_MS,
  main,
  readContract,
  sendOutputFrom,
  sendWaypost
} from "../skills/tech-design-workflow/scripts/send-design-draft-with-review-context.mjs";

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
    const stdout = await captureStdout(() => main(item.args, {
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
    await captureStdout(() => main([
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
      main([
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
    await captureStdout(() => main([
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
    await captureStdout(() => main(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    const before = fs.readFileSync(item.stateFile, "utf8");
    const records = [];
    await captureStdout(() => main(item.args, { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(fs.readFileSync(item.stateFile, "utf8"), before);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("dispatcher never writes lane state after author notification starts", async () => {
  const item = fixture();
  try {
    await captureStdout(() => main(item.args, {
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
    await captureStdout(() => main(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\n## Original Request\nBuild it safely.\n");
    const records = [];
    await captureStdout(() => main(item.args, { requireCommand() {}, runWaypost: successfulWaypost(records) }));
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
      await assert.rejects(main(args, { requireCommand() {}, runWaypost: successfulWaypost([]) }), check.error);
      assert.equal(fs.existsSync(item.stateFile), false);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }

  const item = fixture();
  try {
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\n## Original Request\nBuild it.\n");
    await assert.rejects(main(item.args, { requireCommand() {}, runWaypost: successfulWaypost([]) }), /new design lane requires Context Revision: 1/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
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
