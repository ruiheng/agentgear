#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

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
  --send-timeout-ms <ms>         Default: 20000
  --json
  -h, --help`;

export function receiptFrom(output) {
  const receipt = {};
  for (const token of output.split(/\s+/)) {
    const match = token.match(/^(delivery_id|message_id|blob_id)=(.*)$/);
    if (match) receipt[match[1]] = match[2];
  }
  return receipt;
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

function messageWithTaskContract(header, brief, footer) {
  const terminator = brief.endsWith("\n") ? "" : "\n";
  return `${header}

# Task Contract
${brief}${terminator}
${footer}`;
}

function reviewerBody(options, brief) {
  const header = `Task: ${options.taskId}
Action: review_task_context
From: planner ${options.plannerSessionId}
To: reviewer ${options.reviewerSessionId}
Planner: ${options.plannerSessionId}
Session host: ${options.sessionHost}
Planner workspace: ${options.plannerWorkspace}
Worker workspace: ${options.workerWorkspace}
Task dir: ${options.taskDir}
Workspace lifecycle: ${options.workspaceLifecycle}
Round: context`;
  const footer = `# Review Frame
${branchPlan(options)}

${workspaceHandoff(options)}

# Review Contract
- Treat the planner Task Contract as task authority; apply later User Decisions
- Wait for the matching \`review_requested\`; do not review code from this message
- Workflow policy: ${options.workflowPolicy}
`;
  return messageWithTaskContract(header, brief, footer);
}

function coderBody(options, brief) {
  const header = `Task: ${options.taskId}
Action: execute_delegate_task
From: planner ${options.plannerSessionId}
To: coder ${options.coderSessionId}
Planner: ${options.plannerSessionId}
Session host: ${options.sessionHost}
Planner workspace: ${options.plannerWorkspace}
Worker workspace: ${options.workerWorkspace}
Task dir: ${options.taskDir}
Workspace lifecycle: ${options.workspaceLifecycle}
Round: 1`;
  const review = options.reviewContext === "required"
    ? `- Per-task review: required
- After commit and validation, run \`review-request\` with \`review_lane = task\`
- The review request does not need to mention task content or workflow policy; reviewer already has the planner context
- Preserve User Decisions, Branch Plan, and Workspace Handoff
- Reviewer routing: ref=${options.reviewerSessionRef}; id=${options.reviewerSessionId}`
    : `- Per-task review: skip
- After commit and validation, send \`code_delivery_complete\` to planner`;
  const footer = `# Execution Contract
## Session Contract
- Why persistent session: ${options.sessionReason}

${branchPlan(options)}

## Execution Guardrails
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
  return messageWithTaskContract(header, brief, footer);
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

function positiveInteger(value, label) {
  if (!/^\d+$/.test(value || "") || Number(value) <= 0) fail(`${label} must be a positive integer`);
  return Number(value);
}

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

function sendWaypost(options, toAddress, subject, body) {
  const send = run("waypost", ["send", "--to", toAddress, "--from", options.fromAddress, "--subject", subject, "--content-type", options.contentType, "--schema-version", options.schemaVersion, "--body-file", "-"], {
    input: body,
    timeoutMs: options.sendTimeoutMs
  });
  if (send.timedOut || send.signal) return { status: "interrupted", signal: send.signal || "SIGTERM", timedOut: send.timedOut };
  if (send.error) return { status: "failed", detail: send.error.message };
  if (send.status !== 0) return { status: "failed", detail: (send.stderr || send.stdout).trim() || `exit code ${send.status}` };
  const raw = send.stdout + send.stderr;
  const receipt = receiptFrom(raw);
  return receipt.delivery_id ? { status: "sent", receipt } : { status: "receipt_unknown", raw };
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--task-id", "--start-branch", "--integration-branch", "--task-branch", "--planner-session-id", "--coder-session-id", "--coder-session-ref", "--reviewer-session-id", "--reviewer-session-ref", "--session-host", "--planner-workspace", "--worker-workspace", "--task-dir", "--workspace-lifecycle", "--session-reason", "--from-address", "--to-address", "--reviewer-to-address", "--subject", "--reviewer-subject", "--brief-file", "--review-context", "--workflow-policy", "--artifact-root", "--content-type", "--schema-version", "--send-timeout-ms"],
    flags: ["--json"],
    defaults: { reviewerSessionId: "", reviewerSessionRef: "", reviewerToAddress: "", reviewerSubject: "", workflowPolicy: "unattended; auto_accept_if_no_must_fix=true", artifactRoot: "", contentType: "text/markdown", schemaVersion: "1", sendTimeoutMs: "20000", json: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
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
  requireCommand("waypost");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  options.sendTimeoutMs = positiveInteger(options.sendTimeoutMs, "--send-timeout-ms");
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
    if (options.reviewContext === "required") {
      mutateLock(lockFile, lock => {
        lock.reviewer_session_id = options.reviewerSessionId;
        lock.reviewer_to_address = options.reviewerToAddress;
        lock.reviewer_subject = options.reviewerSubject;
      });
      const reviewSent = sendWaypost(options, options.reviewerToAddress, options.reviewerSubject, reviewerBody(options, brief));
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
      rollback = false;
      mutateLock(lockFile, lock => {
        lock.state = "review_context_sent";
        lock.review_context_delivery_id = reviewContextDeliveryId;
        lock.review_context_message_id = reviewSent.receipt.message_id || null;
        lock.review_context_sent_at = nowIso();
      });
    }

    const coderSent = sendWaypost(options, options.toAddress, options.subject, coderBody(options, brief));
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
    });
    const summary = {
      status: "sent",
      task_id: options.taskId,
      coder_session_id: options.coderSessionId,
      coder_delivery_id: coderSent.receipt.delivery_id,
      reviewer_session_id: options.reviewerSessionId || null,
      review_context_delivery_id: reviewContextDeliveryId || null,
      lock_dir: lockDir,
      lock_file: lockFile,
      lock_output: lockResult.stdout.trim()
    };
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else process.stdout.write(`delegate_dispatch_ok task_id=${options.taskId} coder_delivery_id=${coderSent.receipt.delivery_id} review_context_delivery_id=${reviewContextDeliveryId || "None"} lock_dir=${lockDir}\n`);
  } finally {
    if (rollback && fs.existsSync(lockFile)) rollbackPendingLock(lockFile, lockDir, options.taskId);
  }
}

if (isMain(import.meta.url)) execute(() => main());
