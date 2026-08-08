#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  agentDeckArgs, commandJson, currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, stringField
} from "./workflow-lib.mjs";
import { notifyWorkflowEvent } from "./notify-workflow-event.mjs";

const usage = `Closeout health gate for agent-deck workflow.

Usage:
  closeout-health-gate.mjs [options]

Options:
  --task-id <id>                   Required task id (YYYYMMDD-HHMM-<slug>)
  --worker-workspace <path>        Required worker/shared workspace path
  --planner-session-id <id|title>  Planner session ref (default: current agent-deck session id)
  --coder-session-id <id|title>    Coder session ref (default: coder-<task-id>)
  --reviewer-session-id <id|title> Reviewer session ref (default: reviewer-<task-id>)
  --architect-session-id <id|title> Architect session ref (default: architect-<task-id>)
  --artifact-root <path>           Artifact root (default: .agent-artifacts)
  --profile <name>                 Agent-deck profile
  --max-worker-sessions <n>        Maximum lingering task worker sessions (default: 2)
  --strict                         Exit 3 when health fails
  -h, --help                       Show help`;

function debug(message) {
  if (process.env.ADWF_DEBUG === "1") process.stderr.write(`DEBUG: ${message}\n`);
}

function archiveCounts(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const archive = readJson(filePath);
  const sessions = Array.isArray(archive.sessions) ? archive.sessions : [];
  return {
    blocked: sessions.filter(session => session.delete_status === "blocked_missing_provider_session_id").length,
    failed: sessions.filter(session => session.delete_status === "delete_failed").length,
    residual: sessions.filter(session => session.found === true && !["deleted", "not_found", "skipped_non_disposable_session"].includes(session.delete_status)).length
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--task-id", "--worker-workspace", "--planner-session-id", "--coder-session-id", "--reviewer-session-id", "--architect-session-id", "--artifact-root", "--profile", "--max-worker-sessions"],
    flags: ["--strict"],
    defaults: { taskId: "", workerWorkspace: "", plannerSessionId: "", coderSessionId: "", reviewerSessionId: "", architectSessionId: "", artifactRoot: ".agent-artifacts", profile: "", maxWorkerSessions: "2", strict: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.taskId) fail("--task-id is required");
  if (!options.workerWorkspace) fail("--worker-workspace is required");
  if (!/^\d+$/.test(options.maxWorkerSessions)) fail("--max-worker-sessions must be a non-negative integer");
  if (!fs.statSync(options.workerWorkspace, { throwIfNoEntry: false })?.isDirectory()) fail(`worker-workspace does not exist: ${options.workerWorkspace}`);
  const workerWorkspace = fs.realpathSync(options.workerWorkspace);
  requireCommand("agent-deck");
  if (!options.plannerSessionId) {
    options.plannerSessionId = stringField(commandJson("agent-deck", agentDeckArgs(options.profile, ["session", "current", "--json"])), "id");
    if (!options.plannerSessionId) fail("failed to resolve current agent-deck session id; pass --planner-session-id");
  }
  const refs = {
    coder: options.coderSessionId || `coder-${options.taskId}`,
    reviewer: options.reviewerSessionId || `reviewer-${options.taskId}`,
    architect: options.architectSessionId || `architect-${options.taskId}`
  };
  const script = path.join(currentScriptDirectory(import.meta.url), "archive-and-remove-task-sessions.mjs");
  const args = ["--task-id", options.taskId, "--planner-session-id", options.plannerSessionId, "--coder-session-id", refs.coder, "--reviewer-session-id", refs.reviewer, "--architect-session-id", refs.architect, "--artifact-root", options.artifactRoot, "--apply"];
  if (options.profile) args.push("--profile", options.profile);
  debug(`cleanup_cmd=${process.execPath} ${script} ${args.join(" ")}`);
  const cleanup = invokeNodeScript(script, args);
  if (cleanup.stdout) process.stdout.write(cleanup.stdout);
  if (cleanup.stderr) process.stderr.write(cleanup.stderr);
  const archiveFile = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), options.taskId, `session-archive-${options.taskId}.json`);
  const counts = archiveCounts(archiveFile);
  const list = commandJson("agent-deck", agentDeckArgs(options.profile, ["list", "--json"]));
  const workerCount = Array.isArray(list)
    ? list.filter(session => {
      const title = stringField(session, "title");
      return /^((coder|architect)-\d{8}-\d{4}-|reviewer-(task-|\d{8}-\d{4}-))/.test(title) && stringField(session, "path") === workerWorkspace && /^(running|waiting|idle)$/.test(stringField(session, "status"));
    }).length
    : -1;
  const reasons = [];
  if (cleanup.status !== 0) reasons.push(`cleanup_exit_${cleanup.status}`);
  if (!counts) reasons.push("archive_missing");
  else {
    if (counts.blocked > 0) reasons.push("provider_guard_blocked");
    if (counts.failed > 0) reasons.push("delete_failed");
    if (counts.residual > 0) reasons.push("residual_worker_sessions_for_task");
  }
  if (workerCount < 0) reasons.push("worker_count_unavailable");
  else if (workerCount > Number(options.maxWorkerSessions)) reasons.push("worker_cap_exceeded");
  const checkedAt = nowIso();
  if (reasons.length === 0) {
    process.stdout.write(`health_ok task_id=${options.taskId} checked_at=${checkedAt} archive_file=${archiveFile} worker_sessions=${workerCount}/${options.maxWorkerSessions}\n`);
    return;
  }
  const reasonText = reasons.join(",") || "unknown";
  notifyWorkflowEvent("health_gate_fail", "error", `Health gate failed: ${options.taskId}`, `Reasons: ${reasonText}. Worker sessions ${workerCount}/${options.maxWorkerSessions}.`);
  process.stdout.write(`health_fail task_id=${options.taskId} checked_at=${checkedAt} reasons=${reasonText} archive_file=${archiveFile} worker_sessions=${workerCount}/${options.maxWorkerSessions}\n`);
  if (options.strict) {
    notifyWorkflowEvent("unattended_halt", "error", `Unattended halted: ${options.taskId}`, "Unattended flow halted due to health gate failure.");
    process.exitCode = 3;
    return;
  }
  process.stdout.write(`health_non_strict_continue task_id=${options.taskId} strict=0\n`);
}

if (isMain(import.meta.url)) execute(() => main());
