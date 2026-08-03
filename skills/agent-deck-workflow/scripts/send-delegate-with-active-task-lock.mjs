#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  commandJson, currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, run, sleep, stringField, writeJsonAtomic
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
  --coder-session-ref <ref>       Coder session ref/title
  --task-branch <ref>             Task branch
  --subject <text>                Waypost Message subject
  --body-file <path|->            Body source, or "-" for stdin

Optional:
  --artifact-root <path>          Artifact root (default: <workdir>/.agent-artifacts)
  --content-type <type>           Waypost Message content type (default: text/markdown)
  --schema-version <value>        Waypost Message schema version (default: 1)
  --wake-delay-seconds <n>        Delay before target wake send (default: 10)
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--task-id", "--integration-branch", "--planner-session-id", "--coder-session-id", "--coder-session-ref", "--task-branch", "--subject", "--body-file", "--artifact-root", "--content-type", "--schema-version", "--wake-delay-seconds"],
    flags: ["--json"],
    defaults: { artifactRoot: "", contentType: "text/markdown", schemaVersion: "1", wakeDelaySeconds: "10", json: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["workdir", "--workdir"], ["taskId", "--task-id"], ["integrationBranch", "--integration-branch"], ["plannerSessionId", "--planner-session-id"], ["coderSessionId", "--coder-session-id"], ["coderSessionRef", "--coder-session-ref"], ["taskBranch", "--task-branch"], ["subject", "--subject"], ["bodyFile", "--body-file"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  requireCommand("waypost");
  requireCommand("agent-deck");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  options.workdir = fs.realpathSync(options.workdir);
  if (!options.artifactRoot) options.artifactRoot = path.join(options.workdir, ".agent-artifacts");
  const lockDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");

  const coder = commandJson("agent-deck", ["session", "show", options.coderSessionId, "--json"]);
  const resolvedId = stringField(coder, "id");
  if (!resolvedId) fail(`coder session is not reachable: ${options.coderSessionId}`);
  if (resolvedId !== options.coderSessionId) fail(`--coder-session-id must be a resolved session id; got ${options.coderSessionId}, resolved to ${resolvedId}`);
  const sessionPath = stringField(coder, "path");
  if (!sessionPath || !fs.statSync(sessionPath, { throwIfNoEntry: false })?.isDirectory()) fail(`coder session workspace does not exist: ${sessionPath || options.coderSessionId}`);
  if (fs.realpathSync(sessionPath) !== options.workdir) fail(`coder session workspace mismatch: --workdir=${options.workdir}, session.path=${fs.realpathSync(sessionPath)}`);

  const scriptDir = currentScriptDirectory(import.meta.url);
  const lockResult = invokeNodeScript(path.join(scriptDir, "acquire-active-task-lock.mjs"), [
    "--workdir", options.workdir, "--task-id", options.taskId, "--integration-branch", options.integrationBranch,
    "--planner-session-id", options.plannerSessionId, "--coder-session-id", options.coderSessionId,
    "--coder-session-ref", options.coderSessionRef, "--task-branch", options.taskBranch,
    "--from-address", `agent-deck/${options.plannerSessionId}`, "--to-address", `agent-deck/${options.coderSessionId}`,
    "--subject", options.subject, "--artifact-root", options.artifactRoot
  ]);
  if (lockResult.status !== 0) fail(`failed to acquire active-task lock: ${(lockResult.stderr || lockResult.stdout).trim()}`);
  let rollback = true;
  let completed = false;
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
    const send = run("waypost", ["send", "--to", `agent-deck/${options.coderSessionId}`, "--from", `agent-deck/${options.plannerSessionId}`, "--subject", options.subject, "--content-type", options.contentType, "--schema-version", options.schemaVersion, "--body-file", "-"], { input: body });
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
    const delay = Number(options.wakeDelaySeconds);
    if (Number.isFinite(delay) && delay > 0) await sleep(delay * 1000);
    const wake = run("agent-deck", ["session", "send", "--no-wait", options.coderSessionId, "NOTICE: There might be new message in waypost."]);
    const wakeupStatus = wake.status === 0 ? "sent" : "failed";
    const summary = {
      status: "sent", task_id: options.taskId, from_session_id: options.plannerSessionId, to_session_id: options.coderSessionId,
      to_session_ref: options.coderSessionRef, subject: options.subject, delivery_id: receipt.delivery_id, message_id: receipt.message_id || null,
      blob_id: receipt.blob_id || null, wakeup_status: wakeupStatus, wake_output: (wake.stderr || wake.stdout).trim() || null,
      lock_dir: lockDir, lock_file: lockFile, lock_output: lockResult.stdout.trim()
    };
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else process.stdout.write(`delegate_dispatch_ok task_id=${options.taskId} delivery_id=${receipt.delivery_id} wakeup_status=${wakeupStatus} lock_dir=${lockDir}\n`);
    if (wakeupStatus === "failed") process.stderr.write(`WAKE_FAILED: delegate delivery ${receipt.delivery_id} was queued but target wakeup failed: ${(wake.stderr || wake.stdout).trim() || `exit code ${wake.status}`}\n`);
  } finally {
    if (rollback && !completed && fs.existsSync(lockFile)) {
      try {
        const lock = readJson(lockFile);
        if (stringField(lock, "task_id") === options.taskId && stringField(lock, "state") === "pending_send") fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Preserve a lock we cannot prove belongs to this invocation.
      }
    }
  }
}

if (isMain(import.meta.url)) execute(() => main());
