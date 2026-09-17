import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  main as sendDelegate,
  readDelegateBody
} from "../skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs";
import { DEFAULT_SEND_TIMEOUT_MS } from "../skills/multi-agent-protocol/scripts/workflow-lib.mjs";
import { hasStickyTaskContextMarker } from "../skills/multi-agent-protocol/scripts/compact-memory-shared.mjs";

function exists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function writeExecutable(directory, name, source) {
  const executable = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
  fs.chmodSync(executable, 0o755);
}

// Fake agent-deck: `session show <id> --json` reports the session as existing
// unless its id is listed in AGENT_DECK_MISSING (exit 2, like a real miss) or
// AGENT_DECK_ERROR=1 makes every probe exit 1 (inconclusive).
const agentDeckProbe = `
const a = process.argv.slice(2);
const id = a[0] === "session" && a[1] === "show" ? a[2] : "";
if (process.env.AGENT_DECK_ERROR === "1") process.exit(1);
if ((process.env.AGENT_DECK_MISSING || "").split(",").includes(id)) {
  process.stdout.write(JSON.stringify({ code: "NOT_FOUND", error: "session '" + id + "' not found", success: false }) + "\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ id, success: true, status: "running" }) + "\\n");`;

// Fake thurbox-cli: `session get --json <id>` exits 1 with "session not found"
// for ids in THURBOX_MISSING, exits 0 with a session object otherwise.
const thurboxProbe = `
const a = process.argv.slice(2);
const id = a[a.length - 1] || "";
if ((process.env.THURBOX_MISSING || "").split(",").includes(id)) {
  process.stderr.write("session not found: " + id + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ session: { id, name: id } }) + "\\n");`;

function writeStubBin(directory, waypostSource) {
  writeExecutable(directory, "waypost", waypostSource);
  writeExecutable(directory, "agent-deck", agentDeckProbe);
  writeExecutable(directory, "thurbox-cli", thurboxProbe);
}

function initializeGitWorkspace(workdir, branch = "main") {
  fs.mkdirSync(workdir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Agentgear Test"], { cwd: workdir });
  fs.writeFileSync(path.join(workdir, ".gitkeep"), "");
  execFileSync("git", ["add", ".gitkeep"], { cwd: workdir });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: workdir });
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
    process.env[key] = key === "PATH" && original[key]
      ? `${value}${path.delimiter}${original[key]}`
      : value;
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
  let output = "";
  const stdout = {
    write(chunk) {
      output += String(chunk);
      return true;
    }
  };
  await action(stdout);
  return output;
}

async function captureStderr(action) {
  let output = "";
  const stderr = {
    write(chunk) {
      output += String(chunk);
      return true;
    }
  };
  await action(stderr);
  return output;
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, "process.exit(0);");
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, "process.exit(0);");
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
    initializeGitWorkspace(workdir, "release+safe");
    writeStubBin(bin, loggingWaypost);
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
        "--from-address", "codex/planner+safe",
        "--to-address", "codex/coder+safe"
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
    assert.equal(record.args.includes("codex/planner+safe"), true);
    assert.equal(record.args.includes("codex/coder+safe"), true);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const briefFile = writeBrief(temporary);
    const brief = fs.readFileSync(briefFile, "utf8");
    const policy = "human; auto_accept_if_no_must_fix=false";
    const progress = await captureStderr(stderr => withEnvironment(
      { PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" },
      () => sendDelegate(args(temporary, artifactRoot, briefFile, "required", ["--workflow-policy", policy]), { stderr })
    ));
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(progress, "verified coder session agent-deck/coder-1\nverified reviewer session agent-deck/reviewer-1\nsending reviewer...\nreviewer delivery_id=review-1 durable; notify pending\nsending coder...\ncoder delivery_id=coder-1 durable; notify pending\n");
    for (const [index, record] of records.entries()) {
      assert.deepEqual(record.args.slice(-2), ["--notify", "--ndjson"]);
      assert.deepEqual(
        record.body.split("\n\n", 1)[0].match(/^action:.*$/gim),
        [index === 0 ? "Action: review_task_context" : "Action: execute_delegate_task"]
      );
    }
    assert.match(records[0].body, /Action: review_task_context/);
    assert.match(records[1].body, /Action: execute_delegate_task/);
    assert.match(records[0].body, /Coder: coder-1/);
    assert.match(records[0].body, /declared `Action: review_requested` envelope/);
    assert.match(records[0].body, /Route `rework_required` to the recorded requester/);
    assert.match(records[1].body, /retrieve `agentgear skill get review-request`/);
    assert.match(records[1].body, /delivered `Action: review_requested` envelope/);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const output = await captureStdout(stdout => withEnvironment({
      PATH: bin,
      WAYPOST_LOG: log,
      WAYPOST_MODE: "notify-unconfirmed"
    }, () => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--json"]), { stdout })));

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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const output = await captureStdout(stdout => withEnvironment({
      PATH: bin,
      WAYPOST_LOG: log,
      WAYPOST_MODE: "notify-fail-all"
    }, () => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--json"]), { stdout })));

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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
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
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "timeout" }, async () => {
      await assert.rejects(() => sendDelegate(args(temporary, artifactRoot, brief, "required", ["--send-timeout-ms", "30"])), /reviewer context send interrupted/);
    });
    const lock = JSON.parse(fs.readFileSync(path.join(artifactRoot, "active-task.lock", "lock.json"), "utf8"));
    assert.equal(lock.state, "send_interrupted_unknown");
    assert.equal(lock.send_stage, "reviewer");
    assert.equal(lock.reviewer_session_id, "reviewer-1");
    assert.equal(lock.reviewer_address, "agent-deck/reviewer-1");
    assert.equal(lock.reviewer_subject, "task context: 20260810-review-context -> reviewer");
    assert.equal(lock.coder_address, "agent-deck/coder-1");
    assert.equal(lock.subject, "delegate code: 20260810-review-context -> coder");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("missing coder session is rejected before the lock and before any send", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, AGENT_DECK_MISSING: "coder-1" }, async () => {
      await assert.rejects(
        () => sendDelegate(args(temporary, artifactRoot, brief)),
        error => error?.prefix === "TARGET_SESSION_NOT_FOUND" && /coder session 'coder-1' does not exist/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("missing reviewer session is rejected before the lock and before any send", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, AGENT_DECK_MISSING: "reviewer-1" }, async () => {
      await assert.rejects(
        () => sendDelegate(args(temporary, artifactRoot, brief)),
        error => error?.prefix === "TARGET_SESSION_NOT_FOUND" && /reviewer session 'reviewer-1' does not exist/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("hosted target address id must match the declared session id", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const mismatched = args(temporary, artifactRoot, brief, "skip", ["--to-address", "agent-deck/coder-2"]);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log }, async () => {
      await assert.rejects(
        () => sendDelegate(mismatched),
        error => error?.prefix === "TARGET_SESSION_MISMATCH" && /coder session id 'coder-1' does not match its agent-deck address id 'coder-2'/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("hosted target address scheme must match the declared session host", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const mismatched = args(temporary, artifactRoot, brief, "skip", ["--session-host", "thurbox"]);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log }, async () => {
      await assert.rejects(
        () => sendDelegate(mismatched),
        error => error?.prefix === "TARGET_SESSION_MISMATCH" && /coder session host 'thurbox' does not match its address scheme 'agent-deck'/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("an inconclusive session probe blocks dispatch", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, AGENT_DECK_ERROR: "1" }, async () => {
      await assert.rejects(
        () => sendDelegate(args(temporary, artifactRoot, brief, "skip")),
        error => error?.prefix === "TARGET_SESSION_UNVERIFIED" && /could not verify coder session 'coder-1'/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("non-hosted target schemes skip the session probe", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const codexTarget = args(temporary, artifactRoot, brief, "skip", [
      "--coder-session-id", "thread-1",
      "--to-address", "codex/thread-1"
    ]);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, WAYPOST_MODE: "success" }, async () => {
      await sendDelegate(codexTarget);
    });
    const record = JSON.parse(fs.readFileSync(log, "utf8").trim());
    assert.equal(record.args.includes("codex/thread-1"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("missing thurbox target session is rejected before any send", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-probe-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "waypost.log");
  try {
    initializeGitWorkspace(workdir);
    writeStubBin(bin, loggingWaypost);
    const brief = writeBrief(temporary);
    const thurboxTarget = args(temporary, artifactRoot, brief, "skip", [
      "--coder-session-id", "11111111-2222-3333-4444-555555555555",
      "--session-host", "thurbox",
      "--to-address", "thurbox/11111111-2222-3333-4444-555555555555"
    ]);
    await withEnvironment({ PATH: bin, WAYPOST_LOG: log, THURBOX_MISSING: "11111111-2222-3333-4444-555555555555" }, async () => {
      await assert.rejects(
        () => sendDelegate(thurboxTarget),
        error => error?.prefix === "TARGET_SESSION_NOT_FOUND" && /does not exist on thurbox/.test(error.message)
      );
    });
    assert.equal(exists(log), false);
    assert.equal(exists(path.join(artifactRoot, "active-task.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
