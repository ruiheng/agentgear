import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as sendDelegate, readDelegateBody } from "../skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs";

function pathExists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function writeWaypostExecutable(directory, source = "process.exit(0);") {
  const executable = path.join(directory, "waypost");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
  fs.chmodSync(executable, 0o755);
}

function validBody(temporary) {
  const bodyFile = path.join(temporary, "body.md");
  fs.writeFileSync(bodyFile, [
    "Task: 20260809-send-test",
    "Action: execute_delegate_task",
    "From: planner planner-1",
    "To: coder coder-1",
    "- Integration branch: main",
    "- Task branch: task/20260809-send-test",
    ""
  ].join("\n"));
  return bodyFile;
}

function sendArgs(temporary, artifactRoot, bodyFile, extra = []) {
  return [
    "--workdir", path.join(temporary, "workspace"),
    "--artifact-root", artifactRoot,
    "--task-id", "20260809-send-test",
    "--integration-branch", "main",
    "--planner-session-id", "planner-1",
    "--coder-session-id", "coder-1",
    "--from-address", "agent-deck/planner-1",
    "--to-address", "agent-deck/coder-1",
    "--coder-session-ref", "coder-20260809-send-test",
    "--task-branch", "task/20260809-send-test",
    "--subject", "delegate code: 20260809-send-test -> coder",
    "--body-file", bodyFile,
    ...extra
  ];
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

test("delegate body rejects TTY stdin before reading", () => {
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

test("delegate body converts EAGAIN into an actionable stdin error", () => {
  assert.throws(
    () => readDelegateBody("-", {
      stdinIsTTY: false,
      readFileSync() {
        const error = new Error("resource temporarily unavailable, read");
        error.code = "EAGAIN";
        throw error;
      }
    }),
    error => error?.prefix === "STDIN_UNAVAILABLE"
      && /stdin returned EAGAIN/.test(error.message)
      && /.agent-artifacts\/message\//.test(error.message)
  );
});

test("delegate send rejects an invalid body source before acquiring a task lock", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-test-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const lockDir = path.join(artifactRoot, "active-task.lock");
  const bin = path.join(temporary, "bin");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    writeWaypostExecutable(bin);
    await withEnvironment({ PATH: bin }, async () => {
      await assert.rejects(
        () => sendDelegate([
          "--workdir", workdir,
          "--artifact-root", artifactRoot,
          "--task-id", "20260809-rollback",
          "--integration-branch", "main",
          "--planner-session-id", "planner-1",
          "--coder-session-id", "coder-1",
          "--from-address", "agent-deck/planner-1",
          "--to-address", "agent-deck/coder-1",
          "--coder-session-ref", "coder-20260809-rollback",
          "--task-branch", "task/20260809-rollback",
          "--subject", "delegate code: 20260809-rollback -> coder",
          "--body-file", path.join(temporary, "missing-body.md")
        ]),
        /body file not found/
      );
    });
    assert.equal(pathExists(lockDir), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("delegate send removes its pending lock on a normal Waypost failure", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-test-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const lockDir = path.join(artifactRoot, "active-task.lock");
  const bin = path.join(temporary, "bin");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const bodyFile = validBody(temporary);
    writeWaypostExecutable(bin, 'process.stderr.write("host permission denied\\n"); process.exit(7);');
    await withEnvironment({ PATH: bin }, async () => {
      await assert.rejects(() => sendDelegate(sendArgs(temporary, artifactRoot, bodyFile)), /waypost send failed/);
    });
    assert.equal(pathExists(lockDir), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("delegate send retains an explicitly recoverable lock on timeout", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-send-delegate-test-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts");
  const lockDir = path.join(artifactRoot, "active-task.lock");
  const bin = path.join(temporary, "bin");
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const bodyFile = validBody(temporary);
    writeWaypostExecutable(bin, "setTimeout(() => {}, 10000);");
    await withEnvironment({ PATH: bin }, async () => {
      await assert.rejects(() => sendDelegate(sendArgs(temporary, artifactRoot, bodyFile, ["--send-timeout-ms", "30"])), /SEND_INTERRUPTED|timed out/);
    });
    const lock = JSON.parse(fs.readFileSync(path.join(lockDir, "lock.json"), "utf8"));
    assert.equal(lock.state, "send_interrupted_unknown");
    assert.equal(lock.interruption_kind, "timeout");
    assert.equal(lock.interrupted_by_signal, "SIGTERM");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
