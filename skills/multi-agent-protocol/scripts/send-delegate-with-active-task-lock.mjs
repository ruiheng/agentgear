#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

const usage = `Send one delegated task with workflow-owned active-task lock protection.

Usage:
  send-delegate-with-active-task-lock.mjs [options]

Required:
  --workdir <path>                Worker/shared workspace that owns the active-task artifacts
  --task-id <id>                  Task id
  --integration-branch <ref>      Non-task landing branch
  --planner-session-id <id>       Planner sender session id
  --coder-session-id <id>         Coder target session id
  --from-address <address>        Explicit Waypost sender address
  --to-address <address>          Explicit Waypost recipient address
  --coder-session-ref <ref>       Coder session ref/title
  --task-branch <ref>             Task branch
  --subject <text>                Waypost Message subject
  --body-file <path|->            Body source, or "-" for stdin

Optional:
  --artifact-root <path>          Artifact root (default: <workdir>/.agent-artifacts)
  --content-type <type>           Waypost Message content type (default: text/markdown)
  --schema-version <value>        Waypost Message schema version (default: 1)
  --send-timeout-ms <ms>          Bound the local Waypost send (default: 20000)
  --json                          Emit JSON summary
  -h, --help                      Show help`;

function receiptFrom(output) {
  const receipt = {};
  for (const token of output.split(/\s+/)) {
    const match = token.match(/^(delivery_id|message_id|blob_id)=(.*)$/);
    if (match) receipt[match[1]] = match[2];
  }
  return receipt;
}

function scalar(body, prefix) {
  const line = body.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith(prefix));
  if (!line) return "";
  let value = line.slice(prefix.length).trim();
  if (value.startsWith("`") && value.endsWith("`") && value.length >= 2) value = value.slice(1, -1).trim();
  return value;
}

function validateBody(body, options) {
  const expected = [
    ["Task:", options.taskId, `delegate body is missing matching task header: Task: ${options.taskId}`, "delegate body task header mismatch"],
    ["Action:", "execute_delegate_task", "delegate body is missing Action: execute_delegate_task", "delegate body action mismatch"],
    ["From:", `planner ${options.plannerSessionId}`, `delegate body is missing matching sender header: From: planner ${options.plannerSessionId}`, "delegate body sender mismatch"],
    ["To:", `coder ${options.coderSessionId}`, `delegate body is missing matching recipient header: To: coder ${options.coderSessionId}`, "delegate body recipient mismatch"],
    ["- Integration branch:", options.integrationBranch, `delegate body is missing matching integration branch: ${options.integrationBranch}`, "delegate body integration branch mismatch"],
    ["- Task branch:", options.taskBranch, `delegate body is missing matching task branch: ${options.taskBranch}`, "delegate body task branch mismatch"]
  ];
  for (const [prefix, value, missing, mismatch] of expected) {
    const actual = scalar(body, prefix);
    if (!actual) fail(missing);
    if (actual !== value) fail(`${mismatch}: expected ${value}, got ${actual}`);
  }
}

function mutateLock(lockFile, mutate) {
  const lock = readJson(lockFile);
  mutate(lock);
  writeJsonAtomic(lockFile, lock);
}

function rollbackPendingLock(lockFile, lockDir, taskId) {
  let lock;
  try {
    lock = readJson(lockFile);
  } catch {
    // Preserve an unreadable lock: it cannot safely be attributed to this run.
    return;
  }
  if (stringField(lock, "task_id") === taskId && stringField(lock, "state") === "pending_send") {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(value || "") || Number(value) <= 0) fail(`${label} must be a positive integer`);
  return Number(value);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--task-id", "--integration-branch", "--planner-session-id", "--coder-session-id", "--from-address", "--to-address", "--coder-session-ref", "--task-branch", "--subject", "--body-file", "--artifact-root", "--content-type", "--schema-version", "--send-timeout-ms"],
    flags: ["--json"],
    defaults: { artifactRoot: "", contentType: "text/markdown", schemaVersion: "1", sendTimeoutMs: "20000", json: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["workdir", "--workdir"], ["taskId", "--task-id"], ["integrationBranch", "--integration-branch"], ["plannerSessionId", "--planner-session-id"], ["coderSessionId", "--coder-session-id"], ["fromAddress", "--from-address"], ["toAddress", "--to-address"], ["coderSessionRef", "--coder-session-ref"], ["taskBranch", "--task-branch"], ["subject", "--subject"], ["bodyFile", "--body-file"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  requireCommand("waypost");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  options.sendTimeoutMs = positiveInteger(options.sendTimeoutMs, "--send-timeout-ms");
  options.workdir = fs.realpathSync(options.workdir);
  if (!options.artifactRoot) options.artifactRoot = path.join(options.workdir, ".agent-artifacts");
  const lockDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");

  const scriptDir = currentScriptDirectory(import.meta.url);
  const lockResult = invokeNodeScript(path.join(scriptDir, "acquire-active-task-lock.mjs"), [
    "--workdir", options.workdir, "--task-id", options.taskId, "--integration-branch", options.integrationBranch,
    "--planner-session-id", options.plannerSessionId, "--coder-session-id", options.coderSessionId,
    "--coder-session-ref", options.coderSessionRef, "--task-branch", options.taskBranch,
    "--from-address", options.fromAddress, "--to-address", options.toAddress,
    "--subject", options.subject, "--artifact-root", options.artifactRoot
  ]);
  if (lockResult.status !== 0) fail(`failed to acquire active-task lock: ${(lockResult.stderr || lockResult.stdout).trim()}`);
  let rollback = true;
  let completed = false;
  const retainInterruptedLock = details => {
    rollback = false;
    mutateLock(lockFile, lock => {
      lock.state = "send_interrupted_unknown";
      lock.interruption_kind = details.kind;
      lock.interrupted_by_signal = details.signal;
      lock.interrupted_at = nowIso();
      if (details.timeoutMs) lock.send_timeout_ms = details.timeoutMs;
    });
  };
  try {
    let body;
    if (options.bodyFile === "-") body = fs.readFileSync(0, "utf8");
    else {
      if (!fs.statSync(options.bodyFile, { throwIfNoEntry: false })?.isFile()) fail(`body file not found: ${options.bodyFile}`);
      body = fs.readFileSync(options.bodyFile, "utf8");
    }
    body = body.split("{{FROM_SESSION_ID}}").join(options.plannerSessionId)
      .split("{{TO_SESSION_ID}}").join(options.coderSessionId)
      .split("{{TO_SESSION_REF}}").join(options.coderSessionRef);
    validateBody(body, options);
    const send = run("waypost", ["send", "--to", options.toAddress, "--from", options.fromAddress, "--subject", options.subject, "--content-type", options.contentType, "--schema-version", options.schemaVersion, "--body-file", "-"], {
      input: body,
      timeoutMs: options.sendTimeoutMs
    });
    if (send.timedOut || send.signal) {
      retainInterruptedLock({ kind: send.timedOut ? "timeout" : "signal", signal: send.signal || "SIGTERM", timeoutMs: options.sendTimeoutMs });
      const reason = send.timedOut ? `timed out after ${options.sendTimeoutMs}ms` : `was terminated by ${send.signal}`;
      fail(`waypost send ${reason}; delivery outcome is unknown and the active-task lock was retained for recovery`, 4, "SEND_INTERRUPTED");
    }
    if (send.error) fail(`waypost send failed to start: ${send.error.message}`, 3, "SEND_FAILED");
    if (send.status !== 0) fail(`waypost send failed: ${(send.stderr || send.stdout).trim() || `exit code ${send.status}`}`, 3, "SEND_FAILED");
    completed = true;
    rollback = false;
    const rawReceipt = send.stdout + send.stderr;
    mutateLock(lockFile, lock => {
      lock.state = "queued_receipt_unknown";
      lock.queued_at = nowIso();
      lock.send_receipt_raw = rawReceipt;
    });
    const receipt = receiptFrom(rawReceipt);
    if (!receipt.delivery_id) fail("delegate send succeeded but no delivery_id was returned; lock retained in queued_receipt_unknown for recovery", 5, "SEND_RECEIPT_UNKNOWN");
    mutateLock(lockFile, lock => {
      lock.state = "sent";
      lock.delivery_id = receipt.delivery_id;
      lock.message_id = receipt.message_id || null;
      lock.sent_at = nowIso();
    });
    const summary = {
      status: "sent", task_id: options.taskId, from_session_id: options.plannerSessionId, to_session_id: options.coderSessionId,
      to_session_ref: options.coderSessionRef, subject: options.subject, delivery_id: receipt.delivery_id, message_id: receipt.message_id || null,
      blob_id: receipt.blob_id || null, wakeup_status: "waypost_managed",
      lock_dir: lockDir, lock_file: lockFile, lock_output: lockResult.stdout.trim()
    };
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else process.stdout.write(`delegate_dispatch_ok task_id=${options.taskId} delivery_id=${receipt.delivery_id} wakeup_status=waypost_managed lock_dir=${lockDir}\n`);
  } finally {
    if (rollback && !completed && fs.existsSync(lockFile)) {
      rollbackPendingLock(lockFile, lockDir, options.taskId);
    }
  }
}

if (isMain(import.meta.url)) execute(() => main());
