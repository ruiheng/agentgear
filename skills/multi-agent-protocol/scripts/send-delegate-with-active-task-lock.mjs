#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";
import {
  executeDelegateTaskMessage,
  reviewTaskContextMessage,
  sendExecuteDelegateTaskMessage,
  sendReviewTaskContextMessage
} from "./action-producers.mjs";

const usage = `Send a delegated code task under one active-task lock.

Required:
  --workdir <path>
  --task-id <id>
  --start-branch <ref>
  --integration-branch <ref>
  --task-branch <ref>
  --planner-session-id <id>
  --coder-session-id <id>
  --coder-session-ref <ref>
  --session-host <host>
  --planner-workspace <path>
  --worker-workspace <path>
  --task-dir <path>
  --workspace-lifecycle <value>
  --session-reason <text>
  --from-address <address>
  --to-address <coder-address>
  --subject <coder-subject>
  --brief-file <path>
  --review-context <required|skip>

Required when review-context=required:
  --reviewer-session-id <id>
  --reviewer-session-ref <ref>
  --reviewer-to-address <address>
  --reviewer-subject <text>

Optional:
  --workflow-policy <text>       Default: unattended; auto_accept_if_no_must_fix=true
  --artifact-root <path>         Default: <workdir>/.agent-artifacts
  --content-type <type>          Default: text/markdown
  --schema-version <value>       Default: 1
  --send-timeout-ms <ms>         Default: 0 (disabled; diagnostic override)
  --json
  -h, --help`;

function requirePlainHeaderText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    fail(`${label} has an unsafe header value`);
  }
}

function validateEnvelopeOptions(options) {
  for (const [key, label] of [
    ["taskId", "--task-id"],
    ["plannerSessionId", "--planner-session-id"],
    ["coderSessionId", "--coder-session-id"],
    ["reviewerSessionId", "--reviewer-session-id"],
    ["sessionHost", "--session-host"],
    ["plannerWorkspace", "--planner-workspace"],
    ["workerWorkspace", "--worker-workspace"],
    ["taskDir", "--task-dir"],
    ["workspaceLifecycle", "--workspace-lifecycle"]
  ]) {
    if (key.startsWith("reviewer") && options.reviewContext !== "required") continue;
    requirePlainHeaderText(options[key], label);
  }
}

function optionalOutputString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function sendOutputFrom(output) {
  const payload = JSON.parse(output.trim().split(/\r?\n/, 1)[0]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("waypost send returned a non-object JSON payload");
  }
  const receipt = {};
  for (const key of ["delivery_id", "message_id", "blob_id"]) {
    const value = optionalOutputString(payload[key]);
    if (value) receipt[key] = value;
  }
  const notifyStatus = optionalOutputString(payload.notify_status);
  return {
    receipt,
    notification: {
      status: notifyStatus || "unknown",
      scheme: optionalOutputString(payload.notify_scheme),
      detail: optionalOutputString(payload.notify_detail),
      error: optionalOutputString(payload.notify_error)
        || (notifyStatus ? null : "waypost send --notify returned no notify_status")
    }
  };
}

export function receiptFrom(output) {
  try {
    return sendOutputFrom(output).receipt;
  } catch {
    const receipt = {};
    for (const token of output.split(/\s+/)) {
      const match = token.match(/^(delivery_id|message_id|blob_id)=(.*)$/);
      if (match) receipt[match[1]] = match[2];
    }
    return receipt;
  }
}

function branchPlan(options) {
  return `## Branch Plan
- Start branch: ${options.startBranch}
- Integration branch: ${options.integrationBranch}
- Task branch: ${options.taskBranch}`;
}

function workspaceHandoff(options) {
  return `## Workspace Handoff
- Worker workspace: ${options.workerWorkspace}
- Task dir: ${options.taskDir}
- Workspace lifecycle: ${options.workspaceLifecycle}`;
}

function messageWithTaskContract(messageFactory, before, after, brief, footer) {
  const terminator = brief.endsWith("\n") ? "" : "\n";
  return messageFactory({
    before,
    after,
    body: `# Task Contract
${brief}${terminator}
${footer}`
  });
}

function reviewerBody(options, brief) {
  const before = [{ name: "Task", value: options.taskId }];
  const after = [
    { name: "Planner", value: options.plannerSessionId },
    { name: "Coder", value: options.coderSessionId },
    { name: "Session host", value: options.sessionHost },
    { name: "Planner workspace", value: options.plannerWorkspace },
    { name: "Worker workspace", value: options.workerWorkspace },
    { name: "Task dir", value: options.taskDir },
    { name: "Workspace lifecycle", value: options.workspaceLifecycle },
    { name: "Round", value: "context" }
  ];
  const footer = `# Role
You are the Reviewer for this task. Review the implementation in this session; do not dispatch another reviewer.

# Review Frame
${branchPlan(options)}

${workspaceHandoff(options)}

# Review Contract
- Treat the planner Task Contract as task authority; apply later User Decisions
- Wait for the matching \`review_requested\`; do not review code from this message
- \`.agent-artifacts/active-task.lock/lock.json\` contains addresses for the task's collaborating agents. Read the relevant role field when needed; never infer an address from a session id. If delivery metadata is missing, recover routes from this lock.
- Workflow policy: ${options.workflowPolicy}

# Review Entry and Result Routing
- This context delivery is not a review request. A later request is actionable only when its body has the declared \`Action: review_requested\` envelope and complete review-request fields; an ad-hoc body such as \`Review lane: ...\` / \`Commit: ...\` is malformed. Do not inspect code, produce findings, or acknowledge it as a completed review; report the malformed route to its sender using the shared protocol, then acknowledge that ordinary malformed delivery after the defect message is delivered.
- Before judging code, retrieve \`agentgear skill get review-code/review review-code/continue-1 review-code/continue-2 review-code/continue-3\` and follow that contract. Route \`rework_required\` to the recorded requester (normally the Coder); route only \`work_accepted\` or \`abort_iteration\` to the Planner. Acknowledge the claimed review request only after the full result is delivered.
`;
  return messageWithTaskContract(reviewTaskContextMessage, before, after, brief, footer);
}

function coderBody(options, brief) {
  const before = [{ name: "Task", value: options.taskId }];
  const after = [
    { name: "Planner", value: options.plannerSessionId },
    { name: "Session host", value: options.sessionHost },
    { name: "Planner workspace", value: options.plannerWorkspace },
    { name: "Worker workspace", value: options.workerWorkspace },
    { name: "Task dir", value: options.taskDir },
    { name: "Workspace lifecycle", value: options.workspaceLifecycle },
    { name: "Round", value: "1" }
  ];
  const review = options.reviewContext === "required"
    ? `- Per-task review: required
- After commit and validation, retrieve \`agentgear skill get review-request\` and use its standard send flow with \`review_lane = task\`
- The handoff must be a delivered \`Action: review_requested\` envelope; an ad-hoc review or progress message does not start review
- The review request does not need to mention task content or workflow policy; reviewer already has the planner context
- Preserve User Decisions, Branch Plan, and Workspace Handoff
- Reviewer routing: ref=${options.reviewerSessionRef}; id=${options.reviewerSessionId}`
    : `- Per-task review: skip
- After commit and validation, send \`code_delivery_complete\` to planner`;
  const footer = `# Role
You are the Coder for this task. Implement the task in this session; do not dispatch another coder.

# Execution Contract
## Session Contract
- Why persistent session: ${options.sessionReason}

${branchPlan(options)}

## Execution Guardrails
- \`.agent-artifacts/active-task.lock/lock.json\` contains addresses for the task's collaborating agents. Read the relevant role field when needed; never infer an address from a session id. If delivery metadata is missing, recover routes from this lock.
- Work on the recorded task branch; create or attach it from the integration branch if needed. Never commit detached HEAD.
- Own investigation, decomposition, implementation choices, and validation within this scope
- Make the smallest complete change; keep unrelated work out
- Ask the user before materially changing scope, acceptance criteria, or external behavior
- Keep User Decisions and include them in the next review request or terminal handoff

## Review & Handoff
- Coder git writes and the delivery commit are pre-authorized
${review}
- On a blocker before accepted review, send \`code_delivery_complete\` to planner
- After a review request or terminal handoff succeeds, stop and wait
- Workflow policy: ${options.workflowPolicy}
`;
  return messageWithTaskContract(executeDelegateTaskMessage, before, after, brief, footer);
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
    return;
  }
  if (stringField(lock, "task_id") === taskId && stringField(lock, "state") === "pending_send") {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function nonNegativeInteger(value, label) {
  if (!/^\d+$/.test(value || "")) fail(`${label} must be a non-negative integer`);
  return Number(value);
}

export const DEFAULT_SEND_TIMEOUT_MS = 0;

function stdinUnavailable(detail = "") {
  const suffix = detail ? ` (${detail})` : "";
  fail(`--brief-file - requires piped non-TTY stdin${suffix}; use a file under .agent-artifacts/message/ from an interactive command tool`, 2, "STDIN_UNAVAILABLE");
}

export function readDelegateBody(bodyFile, { stdinIsTTY = Boolean(process.stdin.isTTY), readFileSync = fs.readFileSync } = {}) {
  if (bodyFile !== "-") {
    if (!fs.statSync(bodyFile, { throwIfNoEntry: false })?.isFile()) fail(`brief file not found: ${bodyFile}`);
    return readFileSync(bodyFile, "utf8");
  }
  if (stdinIsTTY) stdinUnavailable("stdin is a TTY");
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    if (error?.code === "EAGAIN") stdinUnavailable("stdin returned EAGAIN");
    throw error;
  }
}

async function sendDeclaredActionMessage(sendMessage, options, toAddress, subject, message, onReceipt) {
  const send = await sendMessage(message, {
    toAddress,
    fromAddress: options.fromAddress,
    subject,
    contentType: options.contentType,
    schemaVersion: options.schemaVersion,
    sendTimeoutMs: options.sendTimeoutMs,
    onReceipt
  });
  // spawnSync may report a timeout after Waypost persisted the send. Preserve
  // a receipt that was already written to stdout instead of discarding it.
  if (send.timedOut || send.signal) {
    try {
      const parsed = sendOutputFrom(send.stdout || "");
      if (parsed.receipt.delivery_id) return { status: "sent", ...parsed };
    } catch {}
    const receipt = receiptFrom(send.stdout || "");
    if (receipt.delivery_id) {
      return {
        status: "sent",
        receipt,
        notification: { status: "unknown", scheme: null, detail: null, error: "Waypost receipt recovered after interruption" }
      };
    }
    return { status: "interrupted", signal: send.signal || "SIGTERM", timedOut: send.timedOut };
  }
  if (send.error) return { status: "failed", detail: `waypost send --notify could not start: ${send.error.message}` };
  if (send.status !== 0) {
    const stream = send.stderr.trim() ? "stderr" : "stdout";
    const detail = (send.stderr || send.stdout).trim() || `exit code ${send.status}`;
    return { status: "failed", detail: `waypost send --notify exited ${send.status} (${stream}): ${detail}` };
  }
  const raw = send.stdout + send.stderr;
  let parsed;
  try {
    parsed = sendOutputFrom(send.stdout);
  } catch {
    const receipt = receiptFrom(send.stdout);
    return receipt.delivery_id
      ? { status: "sent", receipt, notification: { status: "unknown", scheme: null, detail: null, error: "Waypost receipt used legacy text parsing" } }
      : { status: "receipt_unknown", raw };
  }
  return parsed.receipt.delivery_id ? { status: "sent", ...parsed } : { status: "receipt_unknown", raw };
}

function recordNotification(lock, prefix, notification) {
  lock[`${prefix}_notify_status`] = notification.status;
  lock[`${prefix}_notify_scheme`] = notification.scheme;
  lock[`${prefix}_notify_detail`] = notification.detail;
  lock[`${prefix}_notify_error`] = notification.error;
}

function requireReviewRoute(options) {
  for (const [key, label] of [
    ["reviewerSessionId", "--reviewer-session-id"],
    ["reviewerSessionRef", "--reviewer-session-ref"],
    ["reviewerToAddress", "--reviewer-to-address"],
    ["reviewerSubject", "--reviewer-subject"]
  ]) {
    if (!options[key]) fail(`${label} is required when review is required`);
  }
}

function prepareTaskBranch(workdir, integrationBranch, taskBranch) {
  const trackedChanges = run("git", ["-C", workdir, "diff", "--quiet"]);
  const stagedChanges = run("git", ["-C", workdir, "diff", "--cached", "--quiet"]);
  if (trackedChanges.status !== 0 || stagedChanges.status !== 0) {
    fail(`worker workspace is dirty; commit or stash existing changes before preparing task branch '${taskBranch}'`);
  }
  const current = run("git", ["-C", workdir, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current.status === 0 && current.stdout.trim() !== integrationBranch && current.stdout.trim() !== taskBranch) {
    fail(`worker workspace is on unexpected branch '${current.stdout.trim()}', expected '${integrationBranch}' or '${taskBranch}'`);
  }
  const exists = run("git", ["-C", workdir, "rev-parse", "--verify", `refs/heads/${taskBranch}`]);
  if (exists.status !== 0) {
    const created = run("git", ["-C", workdir, "branch", taskBranch, integrationBranch]);
    if (created.status !== 0) fail(`failed to create task branch '${taskBranch}' from '${integrationBranch}': ${(created.stderr || created.stdout).trim()}`);
  }
  const switched = run("git", ["-C", workdir, "switch", taskBranch]);
  if (switched.status !== 0) fail(`failed to attach task branch '${taskBranch}': ${(switched.stderr || switched.stdout).trim()}`);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--task-id", "--start-branch", "--integration-branch", "--task-branch", "--planner-session-id", "--coder-session-id", "--coder-session-ref", "--reviewer-session-id", "--reviewer-session-ref", "--session-host", "--planner-workspace", "--worker-workspace", "--task-dir", "--workspace-lifecycle", "--session-reason", "--from-address", "--to-address", "--reviewer-to-address", "--subject", "--reviewer-subject", "--brief-file", "--review-context", "--workflow-policy", "--artifact-root", "--content-type", "--schema-version", "--send-timeout-ms"],
    flags: ["--json"],
    defaults: { reviewerSessionId: "", reviewerSessionRef: "", reviewerToAddress: "", reviewerSubject: "", workflowPolicy: "unattended; auto_accept_if_no_must_fix=true", artifactRoot: "", contentType: "text/markdown", schemaVersion: "1", sendTimeoutMs: String(DEFAULT_SEND_TIMEOUT_MS), json: false }
  });
  if (options.help) {
    stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [
    ["workdir", "--workdir"], ["taskId", "--task-id"], ["startBranch", "--start-branch"],
    ["integrationBranch", "--integration-branch"], ["taskBranch", "--task-branch"],
    ["plannerSessionId", "--planner-session-id"], ["coderSessionId", "--coder-session-id"],
    ["coderSessionRef", "--coder-session-ref"], ["sessionHost", "--session-host"],
    ["plannerWorkspace", "--planner-workspace"], ["workerWorkspace", "--worker-workspace"],
    ["taskDir", "--task-dir"], ["workspaceLifecycle", "--workspace-lifecycle"],
    ["sessionReason", "--session-reason"], ["fromAddress", "--from-address"],
    ["toAddress", "--to-address"], ["subject", "--subject"], ["briefFile", "--brief-file"],
    ["reviewContext", "--review-context"]
  ]) {
    if (!options[key]) fail(`${label} is required`);
  }
  if (!["required", "skip"].includes(options.reviewContext)) fail("--review-context must be required or skip");
  if (options.reviewContext === "required") requireReviewRoute(options);
  validateEnvelopeOptions(options);
  requireCommand("waypost");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  options.workdir = fs.realpathSync(options.workdir);
  if (!options.artifactRoot) options.artifactRoot = path.join(options.workdir, ".agent-artifacts");
  const lockDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const brief = readDelegateBody(options.briefFile);
  if (!brief.trim()) fail("task brief is empty");

  const scriptDir = currentScriptDirectory(import.meta.url);
  const lockResult = invokeNodeScript(path.join(scriptDir, "acquire-active-task-lock.mjs"), [
    "--workdir", options.workdir,
    "--task-id", options.taskId,
    "--integration-branch", options.integrationBranch,
    "--planner-session-id", options.plannerSessionId,
    "--coder-session-id", options.coderSessionId,
    "--coder-session-ref", options.coderSessionRef,
    "--task-branch", options.taskBranch,
    "--from-address", options.fromAddress,
    "--to-address", options.toAddress,
    "--subject", options.subject,
    "--artifact-root", options.artifactRoot
  ]);
  if (lockResult.status !== 0) fail(`failed to acquire active-task lock: ${(lockResult.stderr || lockResult.stdout).trim()}`);

  let rollback = true;
  let reviewContextDeliveryId = "";
  let reviewContextNotification = null;
  const retainInterrupted = (stage, result) => {
    rollback = false;
    mutateLock(lockFile, lock => {
      lock.state = "send_interrupted_unknown";
      lock.send_stage = stage;
      lock.interruption_kind = result.timedOut ? "timeout" : "signal";
      lock.interrupted_by_signal = result.signal;
      lock.interrupted_at = nowIso();
      lock.send_timeout_ms = options.sendTimeoutMs;
    });
  };
  const retainUnknownReceipt = (stage, raw) => {
    rollback = false;
    mutateLock(lockFile, lock => {
      lock.state = "queued_receipt_unknown";
      lock.send_stage = stage;
      lock.queued_at = nowIso();
      lock.send_receipt_raw = raw;
    });
  };

  try {
    prepareTaskBranch(options.workdir, options.integrationBranch, options.taskBranch);
    if (options.reviewContext === "required") {
      mutateLock(lockFile, lock => {
        lock.reviewer_session_id = options.reviewerSessionId;
        lock.reviewer_address = options.reviewerToAddress;
        lock.reviewer_subject = options.reviewerSubject;
      });
      stderr.write("sending reviewer...\n");
      const reviewSent = await sendDeclaredActionMessage(sendReviewTaskContextMessage, options, options.reviewerToAddress, options.reviewerSubject, reviewerBody(options, brief),
        receipt => stderr.write(`reviewer delivery_id=${receipt.delivery_id} durable; notify pending\n`));
      if (reviewSent.status === "interrupted") {
        retainInterrupted("reviewer", reviewSent);
        fail("reviewer context send interrupted; delivery is unknown", 4, "SEND_INTERRUPTED");
      }
      if (reviewSent.status === "failed") fail(`reviewer context send failed: ${reviewSent.detail}`, 3, "SEND_FAILED");
      if (reviewSent.status === "receipt_unknown") {
        retainUnknownReceipt("reviewer", reviewSent.raw);
        fail("reviewer context sent without a delivery id; inspect Waypost before retry", 5, "SEND_RECEIPT_UNKNOWN");
      }
      reviewContextDeliveryId = reviewSent.receipt.delivery_id;
      reviewContextNotification = reviewSent.notification;
      rollback = false;
      mutateLock(lockFile, lock => {
        lock.state = "review_context_sent";
        lock.review_context_delivery_id = reviewContextDeliveryId;
        lock.review_context_message_id = reviewSent.receipt.message_id || null;
        lock.review_context_sent_at = nowIso();
        recordNotification(lock, "review_context", reviewSent.notification);
      });
    }

    stderr.write("sending coder...\n");
    const coderSent = await sendDeclaredActionMessage(sendExecuteDelegateTaskMessage, options, options.toAddress, options.subject, coderBody(options, brief),
      receipt => stderr.write(`coder delivery_id=${receipt.delivery_id} durable; notify pending\n`));
    if (coderSent.status === "interrupted") {
      retainInterrupted("coder", coderSent);
      fail("coder send interrupted; delivery is unknown", 4, "SEND_INTERRUPTED");
    }
    if (coderSent.status === "failed") {
      if (options.reviewContext === "required") {
        mutateLock(lockFile, lock => {
          lock.state = "coder_send_failed";
          lock.coder_send_failed_at = nowIso();
          lock.coder_send_error = coderSent.detail;
        });
        fail("reviewer context was delivered but coder send failed; active-task lock retained", 3, "SEND_FAILED");
      }
      fail(`coder send failed: ${coderSent.detail}`, 3, "SEND_FAILED");
    }
    if (coderSent.status === "receipt_unknown") {
      retainUnknownReceipt("coder", coderSent.raw);
      fail("coder message sent without a delivery id; inspect Waypost before retry", 5, "SEND_RECEIPT_UNKNOWN");
    }

    rollback = false;
    mutateLock(lockFile, lock => {
      lock.state = "sent";
      lock.delivery_id = coderSent.receipt.delivery_id;
      lock.message_id = coderSent.receipt.message_id || null;
      lock.sent_at = nowIso();
      recordNotification(lock, "coder", coderSent.notification);
    });
    const summary = {
      status: "sent",
      task_id: options.taskId,
      coder_session_id: options.coderSessionId,
      coder_delivery_id: coderSent.receipt.delivery_id,
      coder_notify_status: coderSent.notification.status,
      coder_notify_scheme: coderSent.notification.scheme,
      coder_notify_detail: coderSent.notification.detail,
      coder_notify_error: coderSent.notification.error,
      reviewer_session_id: options.reviewerSessionId || null,
      review_context_delivery_id: reviewContextDeliveryId || null,
      review_context_notify_status: reviewContextNotification?.status || null,
      review_context_notify_scheme: reviewContextNotification?.scheme || null,
      review_context_notify_detail: reviewContextNotification?.detail || null,
      review_context_notify_error: reviewContextNotification?.error || null,
      lock_dir: lockDir,
      lock_file: lockFile,
      lock_output: lockResult.stdout.trim()
    };
    if (options.json) stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else stdout.write(`delegate_dispatch_ok task_id=${options.taskId} coder_delivery_id=${coderSent.receipt.delivery_id} coder_notify_status=${coderSent.notification.status} review_context_delivery_id=${reviewContextDeliveryId || "None"} review_context_notify_status=${reviewContextNotification?.status || "None"} lock_dir=${lockDir}\n`);
  } finally {
    if (rollback && fs.existsSync(lockFile)) rollbackPendingLock(lockFile, lockDir, options.taskId);
  }
}

if (isMain(import.meta.url)) execute(() => main());
