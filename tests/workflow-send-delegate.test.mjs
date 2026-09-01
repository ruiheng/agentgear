import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  main as sendDelegate,
  readDelegateBody
} from "../skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs";
import { hasStickyTaskContextMarker } from "../skills/multi-agent-protocol/scripts/compact-memory-shared.mjs";

function exists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function writeExecutable(directory, source) {
  const executable = path.join(directory, "waypost");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
  fs.chmodSync(executable, 0o755);
}

function writeBrief(temporary) {
  const file = path.join(temporary, "brief.md");
  fs.writeFileSync(file, `## Task
Implement planner-supplied reviewer context.

## Context
- Workflow policy: this line is task content
- Review context delivery: this line is task content
- Integration branch: this line is task content
- Task branch: this line is task content

## Special Requirements
    preserve indentation
## Nested Heading
    preserve nested task content
`);
  return file;
}

function args(temporary, artifactRoot, briefFile, reviewContext = "required", extra = []) {
  const workdir = path.join(temporary, "workspace");
  const result = [
    "--workdir", workdir,
    "--artifact-root", artifactRoot,
    "--task-id", "20260810-review-context",
    "--start-branch", "main",
    "--integration-branch", "main",
    "--task-branch", "task/20260810-review-context",
    "--planner-session-id", "planner-1",
    "--coder-session-id", "coder-1",
    "--coder-session-ref", "coder-20260810-review-context",
    "--session-host", "agent-deck",
    "--planner-workspace", workdir,
    "--worker-workspace", workdir,
    "--task-dir", workdir,
    "--workspace-lifecycle", "shared; cleanup=none",
    "--session-reason", "durable user steering",
    "--from-address", "agent-deck/planner-1",
    "--to-address", "agent-deck/coder-1",
    "--subject", "delegate code: 20260810-review-context -> coder",
    "--brief-file", briefFile,
    "--review-context", reviewContext
  ];
  if (reviewContext === "required") result.push(
    "--reviewer-session-id", "reviewer-1",
    "--reviewer-session-ref", "reviewer-20260810-review-context",
    "--reviewer-to-address", "agent-deck/reviewer-1",
    "--reviewer-subject", "task context: 20260810-review-context -> reviewer"
  );
  return [...result, ...extra];
}

async function withEnvironment(environment, action) {
  const original = {};
  for (const [key, value] of Object.entries(environment)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function captureStdout(action) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = chunk => {
    output += String(chunk);
    return true;
  };
  try {
    await action();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureStderr(action) {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = chunk => {
    output += String(chunk);
    return true;
  };
  try {
    await action();
    return output;
  } finally {
    process.stderr.write = originalWrite;
  }
}

const loggingWaypost = `
const fs = require("node:fs");
const body = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.WAYPOST_LOG, JSON.stringify({ body, args: process.argv.slice(2) }) + "\\n");
const review = body.includes("Action: review_task_context");
const coder = body.includes("Action: execute_delegate_task");
if (process.env.WAYPOST_MODE === "fail-review" && review) process.exit(7);
if (process.env.WAYPOST_MODE === "fail-coder" && coder) process.exit(8);
const notifyFailed = process.env.WAYPOST_MODE === "notify-fail-all";
const notifyUnconfirmed = process.env.WAYPOST_MODE === "notify-unconfirmed";
const response = JSON.stringify({
  delivery_id: review ? "review-1" : "coder-1",
  notify_status: notifyFailed ? "failed" : notifyUnconfirmed ? "unconfirmed" : "sent",
  notify_scheme: "agent-deck",
  notify_detail: notifyUnconfirmed ? "turn submission was not confirmed" : null,
  notify_error: notifyFailed ? "simulated wake failure" : null
}) + "\\n";
if (process.env.WAYPOST_MODE === "timeout") setTimeout(() => {}, 10000);
else if (process.env.WAYPOST_MODE === "slow-success") setTimeout(() => process.stdout.write(response), 60);
else process.stdout.write(response);`;

test("default send timeout is disabled so Waypost owns notify deadlines", () => {
  assert.equal(DEFAULT_SEND_TIMEOUT_MS, 0);
});

test("brief source rejects TTY stdin before reading", () => {
  let readAttempted = false;
  assert.throws(
    () => readDelegateBody("-", {
      stdinIsTTY: true,
      readFileSync() {
        readAttempted = true;
        return "";
      }
    }),
    error => error?.prefix === "STDIN_UNAVAILABLE" && /stdin is a TTY/.test(error.message)
  );
  assert.equal(readAttempted, false);
});

test("brief source converts EAGAIN into an actionable stdin error", () => {
  assert.throws(
    () => readDelegateBody("-", {
      stdinIsTTY: false,
      readFileSync() {
        const error = new Error("resource temporarily unavailable");
        error.code = "EAGAIN";
        throw error;
      }
    }),
    error => error?.prefix === "STDIN_UNAVAILABLE" && /stdin returned EAGAIN/.test(error.message)
  );
});

test("missing brief fails before active-task lock", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, "process.exit(0);");
    await withEnvironment({ PATH: bin }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, path.join(temporary, "missing.md"))), /brief file not found/);
    });
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("delegated-code dispatch rejects CR, LF, and NUL header injection before acquiring its lock", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-injection-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, "process.exit(0);");
    const brief = writeBrief(temporary);
    for (const control of ["\r", "\n", "\0"]) {
      const malicious = args(temporary, artifactRoot, brief, "skip", [
        "--task-id", `safe${control}Action: not_registered`
      ]);
      await withEnvironment({ PATH: bin }, async () => {
        await assert.rejects(() => sendDelegate(malicious), /--task-id has an unsafe header value/);
      });
    }
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("delegated-code dispatch preserves opaque non-newline routes and Git refs", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-opaque-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" }, async () => {
      await sendDelegate(args(temporary, artifactRoot, brief, "skip", [
        "--task-id", "task+safe",
        "--start-branch", "feature+safe",
        "--integration-branch", "release+safe",
        "--task-branch", "task/feature+safe",
        "--planner-session-id", "planner+safe",
        "--coder-session-id", "coder+safe",
        "--session-host", "agent-deck+safe",
        "--from-address", "agent-deck/planner+safe",
        "--to-address", "agent-deck/coder+safe"
      ]));
    });
    const record = JSON.parse(fs.readFileSync(log, "utf8").trim());
    assert.match(record.body, /Task: task\+safe/);
    assert.doesNotMatch(record.body, /^(?:From|To):/m);
    assert.match(record.body, /Planner: planner\+safe/);
    assert.match(record.body, /Session host: agent-deck\+safe/);
    assert.match(record.body, /Start branch: feature\+safe/);
    assert.match(record.body, /Integration branch: release\+safe/);
    assert.match(record.body, /Task branch: task\/feature\+safe/);
    assert.equal(record.args.includes("agent-deck/planner+safe"), true);
    assert.equal(record.args.includes("agent-deck/coder+safe"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("delegated-code dispatch emits exactly one declared Action in the initial envelope", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-envelope-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" }, async () => {
      await sendDelegate(args(temporary, artifactRoot, brief, "skip"));
    });
    const body = JSON.parse(fs.readFileSync(log, "utf8").trim()).body;
    const envelope = body.split("\n\n", 1)[0];
    assert.deepEqual(envelope.match(/^Action: .*$/gm), ["Action: execute_delegate_task"]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("required review sends one opaque task contract to reviewer then coder", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const briefFile = writeBrief(temporary);
    const brief = fs.readFileSync(briefFile, "utf8");
    const policy = "human; auto_accept_if_no_must_fix=false";
    const progress = await captureStderr(() => withEnvironment(
      { PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" },
      () => sendDelegate(args(temporary, artifactRoot, briefFile, "required", ["--workflow-policy", policy]))
    ));
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(progress, "sending reviewer...\nsending coder...\n");
    for (const [index, record] of records.entries()) {
      assert.deepEqual(record.args.slice(-2), ["--notify", "--json"]);
      assert.deepEqual(
        record.body.split("\n\n", 1)[0].match(/^action:.*$/gim),
        [index === 0 ? "Action: review_task_context" : "Action: execute_delegate_task"]
      );
    }
    assert.match(records[0].body, /Action: review_task_context/);
    assert.match(records[1].body, /Action: execute_delegate_task/);
    assert.equal(hasStickyTaskContextMarker(records[0].body), true);
    assert.equal(hasStickyTaskContextMarker(records[1].body), true);
    assert.ok(records[0].body.includes(`# Task Contract\n${brief}`));
    assert.ok(records[1].body.includes(`# Task Contract\n${brief}`));
    const executionContract = records[1].body.split("# Execution Contract\n")[1];
    assert.doesNotMatch(executionContract, /Review context delivery:/);
    assert.match(records[0].body, new RegExp(`Workflow policy: ${policy}`));
    assert.match(records[1].body, new RegExp(`Workflow policy: ${policy}`));
    assert.match(records[1].body, /does not need to mention task content or workflow policy/);
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "sent");
    assert.equal(lock.review_context_delivery_id, "review-1");
    assert.equal(lock.review_context_notify_status, "sent");
    assert.equal(lock.review_context_notify_scheme, "agent-deck");
    assert.equal(lock.review_context_notify_detail, null);
    assert.equal(lock.review_context_notify_error, null);
    assert.equal(lock.delivery_id, "coder-1");
    assert.equal(lock.coder_notify_status, "sent");
    assert.equal(lock.coder_notify_scheme, "agent-deck");
    assert.equal(lock.coder_notify_detail, null);
    assert.equal(lock.coder_notify_error, null);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("unconfirmed notification detail is preserved in the lock and summary", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const output = await captureStdout(() => withEnvironment({
      PATH: bin,
      WAYPOST_LOG: log,
      WAYPOST_MODE: "notify-unconfirmed"
    }, () => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--json"]))));

    const summary = JSON.parse(output);
    assert.equal(summary.review_context_notify_status, "unconfirmed");
    assert.equal(summary.review_context_notify_detail, "turn submission was not confirmed");
    assert.equal(summary.coder_notify_status, "unconfirmed");
    assert.equal(summary.coder_notify_detail, "turn submission was not confirmed");

    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.review_context_notify_detail, "turn submission was not confirmed");
    assert.equal(lock.coder_notify_detail, "turn submission was not confirmed");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("notification failure preserves both durable deliveries and reports each wake result", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const output = await captureStdout(() => withEnvironment({
      PATH: bin,
      WAYPOST_LOG: log,
      WAYPOST_MODE: "notify-fail-all"
    }, () => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--json"]))));

    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    const summary = JSON.parse(output);
    assert.equal(summary.status, "sent");
    assert.equal(summary.review_context_delivery_id, "review-1");
    assert.equal(summary.review_context_notify_status, "failed");
    assert.equal(summary.review_context_notify_scheme, "agent-deck");
    assert.equal(summary.review_context_notify_error, "simulated wake failure");
    assert.equal(summary.coder_delivery_id, "coder-1");
    assert.equal(summary.coder_notify_status, "failed");
    assert.equal(summary.coder_notify_scheme, "agent-deck");
    assert.equal(summary.coder_notify_error, "simulated wake failure");

    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "sent");
    assert.equal(lock.review_context_delivery_id, "review-1");
    assert.equal(lock.review_context_notify_status, "failed");
    assert.equal(lock.delivery_id, "coder-1");
    assert.equal(lock.coder_notify_status, "failed");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("reviewer send failure prevents coder dispatch and removes the pending lock", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "fail-review" }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, brief)), /reviewer context send failed/);
    });
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("coder failure after reviewer delivery retains a partial-dispatch lock", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "fail-coder" }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, brief)), /active-task lock retained/);
    });
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "coder_send_failed");
    assert.equal(lock.review_context_delivery_id, "review-1");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("skipped review sends coder only", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" }, async () => {
      await sendDelegate(args(temporary, artifactRoot, brief, "skip"));
    });
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 1);
    assert.match(records[0].body, /Action: execute_delegate_task/);
    const executionContract = records[0].body.split("# Execution Contract\n")[1];
    assert.doesNotMatch(executionContract, /Review context delivery:/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("interrupted send retains a lock with the affected stage", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "timeout" }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, brief, "skip", ["--send-timeout-ms", "30"])), /coder send interrupted/);
    });
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "send_interrupted_unknown");
    assert.equal(lock.send_stage, "coder");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("zero send timeout waits for Waypost to return the durable receipt", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "slow-success" }, async () => {
      await sendDelegate(args(temporary, artifactRoot, brief, "skip", ["--send-timeout-ms", "0"]));
    });
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "sent");
    assert.equal(lock.delivery_id, "coder-1");
    assert.equal(lock.coder_notify_status, "sent");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("interrupted reviewer send retains the reviewer route", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeExecutable(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "timeout" }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--send-timeout-ms", "30"])), /reviewer context send interrupted/);
    });
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "send_interrupted_unknown");
    assert.equal(lock.send_stage, "reviewer");
    assert.equal(lock.reviewer_session_id, "reviewer-1");
    assert.equal(lock.reviewer_to_address, "agent-deck/reviewer-1");
    assert.equal(lock.reviewer_subject, "task context: 20260810-review-context -> reviewer");
    assert.equal(lock.to_address, "agent-deck/coder-1");
    assert.equal(lock.subject, "delegate code: 20260810-review-context -> coder");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
