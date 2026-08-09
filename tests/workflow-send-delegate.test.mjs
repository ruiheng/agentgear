import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as sendDelegate } from "../skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs";

function pathExists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function writeWaypostExecutable(directory) {
  const executable = path.join(directory, "waypost");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.exit(0);\n`);
  fs.chmodSync(executable, 0o755);
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

test("delegate send removes its pending lock when validation fails before Waypost send", async () => {
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
