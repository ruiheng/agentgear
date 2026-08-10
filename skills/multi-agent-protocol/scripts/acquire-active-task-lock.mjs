#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  execute, fail, isMain, nowIso, parseArgs, readJson, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

const usage = `Acquire the workflow active-task lock for one delegated task.

Usage:
  acquire-active-task-lock.mjs [options]

Required:
  --workdir <path>               Workspace path that owns .agent-artifacts/
  --task-id <id>                 Task id
  --integration-branch <ref>     Non-task landing branch
  --planner-session-id <id>      Planner session id for workflow metadata
  --coder-session-id <id>        Coder session id for workflow metadata
  --from-address <address>       Explicit Waypost sender address
  --to-address <address>         Explicit Waypost recipient address

Optional:
  --coder-session-ref <ref>      Coder session ref/title
  --task-branch <ref>            Task branch for metadata only
  --subject <text>               Message subject for metadata
  --artifact-root <path>         Artifact root
  -h, --help                     Show help`;

function lockBlockReason(lock) {
  const state = stringField(lock, "state");
  const stage = stringField(lock, "send_stage") || "delegate";
  if (state === "send_interrupted_unknown") return `prior ${stage} send was interrupted with unknown delivery (state=${state}); inspect Waypost before deleting this lock`;
  if (state === "queued_receipt_unknown") return `prior ${stage} send succeeded but its receipt was not parsed (state=${state}); inspect Waypost before deleting this lock`;
  if (state === "coder_send_failed") return `reviewer context was delivered but coder send failed (state=${state} review_context_delivery_id=${stringField(lock, "review_context_delivery_id") || "unknown"}); inspect the partial dispatch before deleting this lock`;
  return "inspect the prior task and remove this lock only after verifying it is finished";
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--task-id", "--integration-branch", "--planner-session-id", "--coder-session-id", "--coder-session-ref", "--task-branch", "--from-address", "--to-address", "--subject", "--artifact-root"],
    defaults: { plannerSessionId: "", coderSessionId: "", coderSessionRef: "", taskBranch: "", fromAddress: "", toAddress: "", subject: "", artifactRoot: "" }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["workdir", "--workdir"], ["taskId", "--task-id"], ["integrationBranch", "--integration-branch"], ["plannerSessionId", "--planner-session-id"], ["coderSessionId", "--coder-session-id"], ["fromAddress", "--from-address"], ["toAddress", "--to-address"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  const workdir = fs.realpathSync(options.workdir);
  if (!options.artifactRoot) options.artifactRoot = path.join(workdir, ".agent-artifacts");
  const lockDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");
  fs.mkdirSync(options.artifactRoot, { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.statSync(lockDir, { throwIfNoEntry: false })?.isDirectory()) fail(`active-task lock path exists and is not a directory: ${lockDir}`);
    let existing = null;
    try { existing = readJson(lockFile); } catch { /* Preserve an unreadable lock. */ }
    const taskId = stringField(existing, "task_id") || "<unknown>";
    const state = stringField(existing, "state") || "<unknown>";
    fail(`active task lock exists: ${lockDir} :: task_id=${taskId} :: state=${state} :: ${existing ? lockBlockReason(existing) : "inspect and remove this directory manually after verifying the prior task is finished"}`, 3, "LOCK_EXISTS");
  }
  writeJsonAtomic(lockFile, {
    task_id: options.taskId,
    action: "execute_delegate_task",
    state: "pending_send",
    planner_session_id: options.plannerSessionId,
    coder_session_id: options.coderSessionId,
    from_address: options.fromAddress,
    to_address: options.toAddress,
    subject: options.subject || null,
    task_branch: options.taskBranch || null,
    integration_branch: options.integrationBranch,
    coder_session_ref: options.coderSessionRef || null,
    created_at: nowIso()
  });
  process.stdout.write(`active_task_lock status=acquired lock_dir=${lockDir} lock_file=${lockFile}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
