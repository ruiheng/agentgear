import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as sendDelegate, readDelegateBody } from "../skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs";

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

const loggingWaypost = `
const fs = require("node:fs");
const body = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.WAYPOST_LOG, JSON.stringify({ body, args: process.argv.slice(2) }) + "\\n");
const review = body.includes("Action: review_task_context");
const coder = body.includes("Action: execute_delegate_task");
if (process.env.WAYPOST_MODE === "fail-review" && review) process.exit(7);
if (process.env.WAYPOST_MODE === "fail-coder" && coder) process.exit(8);
if (process.env.WAYPOST_MODE === "timeout") setTimeout(() => {}, 10000);
process.stdout.write("delivery_id=" + (review ? "review-1" : "coder-1") + " message_id=message-1\\n");`;

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
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" }, async () => {
      await sendDelegate(args(temporary, artifactRoot, briefFile, "required", ["--workflow-policy", policy]));
    });
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.match(records[0].body, /Action: review_task_context/);
    assert.match(records[1].body, /Action: execute_delegate_task/);
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
    assert.equal(lock.delivery_id, "coder-1");
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
