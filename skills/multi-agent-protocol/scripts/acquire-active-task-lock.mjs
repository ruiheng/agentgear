#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  commandJson, execute, fail, isMain, nowIso, parseArgs, readJson, requireCommand, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

const usage = `Acquire the workflow active-task lock for one delegated task.

Usage:
  acquire-active-task-lock.mjs [options]

Options:
  --workdir <path>               Required workspace path that owns .agent-artifacts/
  --task-id <id>                 Required task id
  --integration-branch <ref>     Required non-task landing branch
  --planner-session-id <id|ref>  Planner session id/ref (default: current session id)
  --coder-session-id <id|ref>    Optional coder session id/ref
  --coder-session-ref <ref>      Optional coder session ref/title
  --task-branch <ref>            Optional task branch for metadata only
  --from-address <address>       Optional sender address
  --to-address <address>         Optional recipient address
  --subject <text>               Optional message subject for metadata
  --artifact-root <path>         Optional artifact root
  -h, --help                     Show help`;

function sessionExists(sessionRef) {
  return Boolean(stringField(commandJson("agent-deck", ["session", "show", sessionRef, "--json"]), "id"));
}

function lockSessionRefs(lock) {
  const addressRef = value => value.startsWith("agent-deck/") ? value.slice("agent-deck/".length) : "";
  const primary = [addressRef(stringField(lock, "to_address")), stringField(lock, "coder_session_ref")].filter(Boolean);
  return primary.length > 0
    ? [...new Set(primary)]
    : [...new Set([stringField(lock, "planner_session_id"), addressRef(stringField(lock, "from_address"))].filter(Boolean))];
}

function lockBlockReason(lock) {
  const state = stringField(lock, "state");
  if (state === "send_interrupted_unknown") return `prior delegate send was interrupted during message send (state=${state} signal=${stringField(lock, "interrupted_by_signal") || "unknown"} interrupted_at=${stringField(lock, "interrupted_at") || "unknown"}); inspect Waypost message delivery before deleting this lock`;
  if (state === "queued_receipt_unknown") return `prior delegate send succeeded but receipt could not be parsed (state=${state}); inspect Waypost message delivery before deleting this lock`;
  return "delete this directory manually after verifying the prior task is finished";
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
  for (const [key, label] of [["workdir", "--workdir"], ["taskId", "--task-id"], ["integrationBranch", "--integration-branch"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);
  requireCommand("agent-deck");
  const workdir = fs.realpathSync(options.workdir);
  if (!options.plannerSessionId) {
    options.plannerSessionId = stringField(commandJson("agent-deck", ["session", "current", "--json"]), "id");
    if (!options.plannerSessionId) fail("failed to resolve current agent-deck session id; pass --planner-session-id");
  }
  if (!options.fromAddress) options.fromAddress = `agent-deck/${options.plannerSessionId}`;
  if (!options.toAddress && options.coderSessionId) options.toAddress = `agent-deck/${options.coderSessionId}`;
  if (!options.artifactRoot) options.artifactRoot = path.join(workdir, ".agent-artifacts");
  const lockDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");
  fs.mkdirSync(options.artifactRoot, { recursive: true });
  let staleReplaced = false;
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.statSync(lockDir, { throwIfNoEntry: false })?.isDirectory()) fail(`active-task lock path exists and is not a directory: ${lockDir}`);
    let existing = null;
    try { existing = readJson(lockFile); } catch { /* Treat an invalid lock as active. */ }
    const refs = existing ? lockSessionRefs(existing) : [];
    const stale = refs.length > 0 && refs.every(ref => !sessionExists(ref));
    if (!stale) {
      const taskId = stringField(existing, "task_id") || "<unknown>";
      const state = stringField(existing, "state") || "<unknown>";
      fail(`active task lock exists: ${lockDir} :: task_id=${taskId} :: state=${state} :: ${existing ? lockBlockReason(existing) : "delete this directory manually after verifying the prior task is finished"}`, 3, "LOCK_EXISTS");
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
    staleReplaced = true;
  }
  writeJsonAtomic(lockFile, {
    task_id: options.taskId,
    action: "execute_delegate_task",
    state: "pending_send",
    planner_session_id: options.plannerSessionId || null,
    from_address: options.fromAddress || null,
    to_address: options.toAddress || null,
    subject: options.subject || null,
    task_branch: options.taskBranch || null,
    integration_branch: options.integrationBranch,
    coder_session_ref: options.coderSessionRef || null,
    created_at: nowIso()
  });
  process.stdout.write(`active_task_lock status=${staleReplaced ? "stale_replaced" : "acquired"} lock_dir=${lockDir} lock_file=${lockFile}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
