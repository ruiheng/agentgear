#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  currentScriptDirectory, execute, fail, invokeNodeScript, isMain, nowIso, parseArgs, readJson, requireCommand, run, stringField, writeJsonAtomic, appendJsonLine
} from "./workflow-lib.mjs";
import { notifyWorkflowEvent } from "./notify-workflow-event.mjs";

const usage = `Planner closeout batch with strict required-action ordering.

Required actions (hard-fail): merge the task branch, then append a planner progress record.
Optional actions: message acknowledgement, active-task-lock cleanup, task-session cleanup, mirrored workspace-record cleanup, branch pruning, and notifications.

Usage:
  planner-closeout-batch.mjs [options]

Options:
  --task-id <id>                   Required task id
  --task-branch <ref>              Task branch (default: task/<task-id>)
  --integration-branch <ref>       Required non-task landing branch
  --worker-workspace <path>        Required worker/shared workspace path
  --planner-workspace <path>       Required planner closeout workspace path
  --worker-artifact-root <path>    Worker artifact root
  --planner-artifact-root <path>   Planner artifact root
  --artifact-root <path>           Alias for --planner-artifact-root
  --progress-file <path>           Progress JSONL path
  --task-dir <path>                Required task worktree for task lock cleanup
  --worker-dir <path>              Alias for --task-dir
  --planner-session-id <id>        Required opaque planner session id
  --session-host <host>            Recorded task session host
  --coder-session-id <id>          Exact task coder session id
  --reviewer-session-id <id>       Exact task reviewer session id
  --architect-session-id <id>      Exact task architect session id
  --session-profile <name>         Optional host profile
  --merge-mode <mode>              ff-only|ff|no-ff (default: ff-only)
  --allow-dirty                    Allow dirty planner worktree
  --override-workspaces            Replace workspace records after confirmation
  --run-prune [--prune-apply]      Run optional branch cleanup
  --ack-delivery-id <id> --ack-lease-token <token>
  -h, --help                       Show help`;

function debug(message) {
  if (process.env.ADWF_DEBUG === "1") process.stderr.write(`DEBUG: ${message}\n`);
}

function warn(message) {
  process.stderr.write(`WARN: ${message}\n`);
}

function git(workspace, args) {
  return run("git", ["-C", workspace, ...args]);
}

function workspace(value, label) {
  if (!fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) fail(`${label} does not exist: ${value}`);
  if (git(value, ["rev-parse", "--is-inside-work-tree"]).status !== 0) fail(`workspace is not inside a git repository: ${value}`);
  return fs.realpathSync(value);
}

function taskBranchRef(value) {
  return /^(?:task\/|refs\/heads\/task\/|refs\/remotes\/[^/]+\/task\/)/.test(value);
}

function sameArtifactRoot(left, right) {
  const normalize = value => value.replace(/[\\/]+$/, "");
  if (normalize(left) === normalize(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
}

function releaseLock(root, taskId) {
  const lockDir = path.join(root.replace(/[\\/]+$/, ""), "active-task.lock");
  const lockFile = path.join(lockDir, "lock.json");
  if (!fs.statSync(lockDir, { throwIfNoEntry: false })?.isDirectory()) return { status: "not_present", failed: false };
  try {
    const lock = readJson(lockFile);
    const lockTask = stringField(lock, "task_id");
    if (!lockTask) return { status: "metadata_missing", failed: true, warning: `active-task lock metadata missing: ${lockFile}; remove ${lockDir} manually if the task is already finished` };
    if (lockTask !== taskId) return { status: "task_mismatch", failed: true, warning: `active-task lock belongs to task_id=${lockTask}, not ${taskId}: ${lockDir}; remove it manually after verification` };
    fs.rmSync(lockDir, { recursive: true, force: true });
    return { status: "released", failed: false };
  } catch (error) {
    return { status: "release_failed", failed: true, warning: `failed to remove active-task lock: ${lockDir}; ${error.message}` };
  }
}

function cleanupArchiveSummary(filePath) {
  if (!fs.existsSync(filePath)) return { status: "archive_missing", failed: true, warning: true };
  const archive = readJson(filePath);
  const sessions = Array.isArray(archive.sessions) ? archive.sessions : [];
  const statuses = sessions.map(session => stringField(session, "delete_status"));
  if (statuses.some(status => ["blocked_missing_provider_session_id", "delete_failed"].includes(status))) {
    return { status: "failed", failed: true, warning: true };
  }
  if (statuses.some(status => status === "skipped_non_disposable_session")) {
    return { status: "preserved_non_disposable", failed: false, warning: true };
  }
  if (statuses.some(status => status === "preserved_unsupported_host")) {
    return { status: "preserved_unsupported_host", failed: false, warning: true };
  }
  return { status: "complete", failed: false, warning: false };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--task-id", "--task-branch", "--integration-branch", "--worker-workspace", "--planner-workspace", "--worker-artifact-root", "--planner-artifact-root", "--artifact-root", "--progress-file", "--task-dir", "--worker-dir", "--planner-session-id", "--session-host", "--coder-session-id", "--reviewer-session-id", "--architect-session-id", "--session-profile", "--merge-mode", "--ack-delivery-id", "--ack-lease-token"],
    flags: ["--allow-dirty", "--override-planner-workspace", "--override-workspaces", "--run-prune", "--prune-apply"],
    defaults: {
      taskId: "", taskBranch: "", integrationBranch: "", workerWorkspace: "", plannerWorkspace: "", workerArtifactRoot: "", plannerArtifactRoot: "", artifactRoot: "", progressFile: "", taskDir: "", workerDir: "", plannerSessionId: "", sessionHost: "", coderSessionId: "", reviewerSessionId: "", architectSessionId: "", sessionProfile: "", mergeMode: "ff-only", allowDirty: false, overridePlannerWorkspace: false, overrideWorkspaces: false, runPrune: false, pruneApply: false, ackDeliveryId: "", ackLeaseToken: ""
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.taskId) fail("--task-id is required");
  const taskDirInput = options.taskDir || options.workerDir;
  if (!taskDirInput) fail("--task-dir is required");
  if (!options.integrationBranch) fail("--integration-branch is required");
  if (!options.workerWorkspace) fail("--worker-workspace is required");
  if (!options.plannerWorkspace) fail("--planner-workspace is required");
  if (!options.plannerSessionId) fail("--planner-session-id is required");
  const taskSessionIds = [options.coderSessionId, options.reviewerSessionId, options.architectSessionId].filter(Boolean);
  if (taskSessionIds.length > 0 && !options.sessionHost) fail("--session-host is required when task session ids are provided");
  if (!["ff-only", "ff", "no-ff"].includes(options.mergeMode)) fail("--merge-mode must be one of: ff-only|ff|no-ff");
  if (options.pruneApply && !options.runPrune) fail("--prune-apply requires --run-prune");
  if (Boolean(options.ackDeliveryId) !== Boolean(options.ackLeaseToken)) fail(options.ackLeaseToken ? "--ack-lease-token requires --ack-delivery-id" : "--ack-delivery-id requires --ack-lease-token");
  requireCommand("git");
  if (options.ackDeliveryId) requireCommand("waypost");
  const workerWorkspace = workspace(options.workerWorkspace, "workspace");
  const plannerWorkspace = workspace(options.plannerWorkspace, "workspace");
  if (!fs.statSync(taskDirInput, { throwIfNoEntry: false })?.isDirectory()) fail(`task-dir does not exist: ${taskDirInput}`);
  const taskDir = fs.realpathSync(taskDirInput);
  const workerArtifactRoot = options.workerArtifactRoot || path.join(workerWorkspace, ".agent-artifacts");
  const plannerArtifactRoot = options.plannerArtifactRoot || options.artifactRoot || path.join(plannerWorkspace, ".agent-artifacts");
  const taskBranch = options.taskBranch || `task/${options.taskId}`;
  const progressFile = options.progressFile || path.join(plannerArtifactRoot, "workflow-progress", "progress.jsonl");
  const plannerSessionRef = options.plannerSessionId;
  if (taskBranchRef(options.integrationBranch)) fail(`refusing task-scoped integration branch '${options.integrationBranch}' for task branch '${taskBranch}'; pass the real non-task landing branch with --integration-branch`);
  if (taskBranch === options.integrationBranch) fail("--task-branch must differ from integration branch");
  if (git(plannerWorkspace, ["rev-parse", "--verify", options.integrationBranch]).status !== 0) fail(`integration branch does not exist in planner workspace: ${options.integrationBranch}`);
  if (git(plannerWorkspace, ["rev-parse", "--verify", taskBranch]).status !== 0) fail(`task branch does not exist in planner workspace: ${taskBranch}`);

  const notify = (event, severity, title, message) => notifyWorkflowEvent(event, severity, title, message, options.taskId, plannerArtifactRoot);
  const blocker = (event, message) => {
    notify(event, "error", `Planner closeout blocked: ${options.taskId}`, message);
    fail(message);
  };
  const workerLockDir = path.join(workerArtifactRoot.replace(/[\\/]+$/, ""), "active-task.lock");
  const workerLockFile = path.join(workerLockDir, "lock.json");
  if (fs.statSync(workerLockDir, { throwIfNoEntry: false })?.isDirectory()) {
    let lock;
    try { lock = readJson(workerLockFile); } catch { blocker("planner_closeout_lock_metadata_missing", `workspace active-task lock metadata missing: ${workerLockFile}`); }
    if (stringField(lock, "task_id") !== options.taskId) blocker("planner_closeout_lock_task_mismatch", `workspace active-task lock belongs to task_id=${stringField(lock, "task_id") || "<unknown>"}, not ${options.taskId}: ${workerLockDir}`);
    if (!stringField(lock, "integration_branch")) blocker("planner_closeout_lock_branch_missing", `workspace active-task lock missing integration_branch: ${workerLockFile}`);
    if (stringField(lock, "integration_branch") !== options.integrationBranch) blocker("planner_closeout_lock_branch_mismatch", `workspace active-task lock integration branch mismatch: lock='${stringField(lock, "integration_branch")}' closeout='${options.integrationBranch}'`);
  }
  if (!options.allowDirty && (git(plannerWorkspace, ["diff", "--quiet"]).status !== 0 || git(plannerWorkspace, ["diff", "--cached", "--quiet"]).status !== 0)) blocker("planner_closeout_dirty_worktree", `dirty planner worktree/index at '${plannerWorkspace}'; commit or stash first (or pass --allow-dirty)`);
  const scriptDir = currentScriptDirectory(import.meta.url);
  if (options.overridePlannerWorkspace || options.overrideWorkspaces) {
    const prepareArgs = ["--worker-workspace", workerWorkspace, "--planner-workspace", plannerWorkspace, "--integration-branch", options.integrationBranch, "--planner-session-id", plannerSessionRef, "--worker-artifact-root", workerArtifactRoot, "--planner-artifact-root", plannerArtifactRoot, "--override-workspaces"];
    if (options.allowDirty) prepareArgs.push("--allow-dirty");
    const prepared = invokeNodeScript(path.join(scriptDir, "prepare-workspaces.mjs"), prepareArgs);
    if (prepared.status !== 0) blocker("planner_closeout_workspace_prepare_failed", `failed to override workspace records: ${(prepared.stderr || prepared.stdout).trim()}`);
  }
  const recordFile = path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), "planner-workspace.json");
  if (!fs.existsSync(recordFile)) blocker("planner_closeout_workspace_record_missing", `planner workspace record missing: ${recordFile}`);
  const record = readJson(recordFile);
  const recordPlanner = stringField(record, "planner_session_id");
  const recordBranch = stringField(record, "integration_branch");
  if (!recordPlanner) blocker("planner_closeout_workspace_planner_missing", `planner workspace record missing planner_session_id: ${recordFile}`);
  if (!recordBranch) blocker("planner_closeout_workspace_branch_missing", `planner workspace record missing integration_branch: ${recordFile}`);
  if (recordPlanner !== plannerSessionRef) blocker("planner_closeout_workspace_planner_mismatch", `planner workspace planner mismatch: record='${recordPlanner}' closeout='${plannerSessionRef}'`);
  if (recordBranch !== options.integrationBranch) blocker("planner_closeout_workspace_branch_mismatch", `planner workspace integration branch mismatch: record='${recordBranch}' closeout='${options.integrationBranch}'`);

  const original = git(plannerWorkspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const startedBranch = original.status === 0 ? original.stdout.trim() : "detached";
  let switched = false;
  if (startedBranch !== options.integrationBranch) {
    process.stdout.write(`auto_switch_integration_branch from=${startedBranch} to=${options.integrationBranch}\n`);
    const switchedResult = git(plannerWorkspace, ["switch", options.integrationBranch]);
    if (switchedResult.status !== 0) {
      notify("planner_closeout_switch_failed", "error", `Planner closeout blocked: ${options.taskId}`, `Failed to attach integration branch '${options.integrationBranch}' from '${startedBranch}'.`);
      if (switchedResult.stderr || switchedResult.stdout) process.stderr.write(switchedResult.stderr || switchedResult.stdout);
      fail(`failed to switch from '${startedBranch}' to integration branch '${options.integrationBranch}'. If git says the branch is already checked out in another worktree, rerun closeout from that worktree or release that worktree first; do not create a temporary closeout worktree.`);
    }
    if (switchedResult.stdout || switchedResult.stderr) process.stdout.write(switchedResult.stdout || switchedResult.stderr);
    switched = true;
  }
  const attached = git(plannerWorkspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (attached.status !== 0 || attached.stdout.trim() !== options.integrationBranch) fail(`required merge must run on attached integration branch '${options.integrationBranch}', got '${attached.status === 0 ? attached.stdout.trim() : "detached"}'`);

  const mergeFlag = { "ff-only": "--ff-only", ff: "--ff", "no-ff": "--no-ff" }[options.mergeMode];
  debug(`required.start task_id=${options.taskId} integration=${options.integrationBranch} task_branch=${taskBranch} merge_mode=${options.mergeMode}`);
  const merged = git(plannerWorkspace, ["merge", mergeFlag, taskBranch]);
  if (merged.status !== 0) {
    notify("planner_closeout_required_fail", "error", `Planner closeout failed: ${options.taskId}`, `Required merge failed on ${options.integrationBranch} <- ${taskBranch}.`);
    if (merged.stderr || merged.stdout) process.stderr.write(merged.stderr || merged.stdout);
    fail(`merge failed integration='${options.integrationBranch}' task_branch='${taskBranch}'`, 3, "REQUIRED_ACTION_FAILED");
  }
  if (merged.stdout || merged.stderr) process.stdout.write(merged.stdout || merged.stderr);
  const mergedShaResult = git(plannerWorkspace, ["rev-parse", "HEAD"]);
  const mergedSha = mergedShaResult.status === 0 ? mergedShaResult.stdout.trim() : "";
  if (!mergedSha) fail("failed to resolve merged HEAD", 3, "REQUIRED_ACTION_FAILED");
  const stateFile = path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), "workflow-progress", `closeout-state-${options.taskId}.json`);
  const previous = fs.existsSync(stateFile) ? readJson(stateFile) : null;
  if (!(previous?.required_actions?.progress_updated === true && previous?.required_actions?.merged_sha === mergedSha)) {
    try {
      appendJsonLine(progressFile, {
        task_id: options.taskId, timestamp: nowIso(), status: "required_complete", started_branch: startedBranch, integration_branch: options.integrationBranch,
        task_branch: taskBranch, integration_branch_source: "explicit", task_scoped_integration_branch: false, merged_sha: mergedSha,
        closeout_source: "waypost_message", switched_integration_branch: switched
      });
    } catch {
      fail(`failed to append progress record to ${progressFile}`, 3, "REQUIRED_ACTION_FAILED");
    }
  }

  let pruneStatus = "skipped";
  const healthStatus = "not_applicable";
  let workspaceLockStatus = "not_checked";
  let taskWorkspaceLockStatus = "not_checked";
  let workspaceRecordStatus = "not_checked";
  let sessionCleanupStatus = taskSessionIds.length > 0 ? "pending" : "not_requested";
  let sessionCleanupArchive = null;
  let optionalFails = 0;
  let workspaceReleaseBlocked = false;
  let ackRequested = Boolean(options.ackDeliveryId);
  let ackCompleted = false;
  let ackStatus = ackRequested ? "pending" : "not_requested";
  if (ackRequested && ((previous?.required_actions?.message_ack_completed === true && previous?.required_actions?.message_ack?.delivery_id === options.ackDeliveryId) || (previous?.required_actions?.mailbox_ack_completed === true && previous?.required_actions?.mailbox_ack?.delivery_id === options.ackDeliveryId))) {
    ackCompleted = true;
    ackStatus = "already_recorded";
  }
  const writeState = () => writeJsonAtomic(stateFile, {
    task_id: options.taskId, updated_at: nowIso(), started_branch: startedBranch, integration_branch: options.integrationBranch, task_branch: taskBranch,
    integration_branch_source: "explicit", task_scoped_integration_branch: false, closeout_source: "waypost_message", progress_file: progressFile,
    required_actions: { switched_integration_branch: switched, merge_mode: options.mergeMode, merge_completed: true, merged_sha: mergedSha, progress_updated: true,
      message_ack_requested: ackRequested, message_ack_completed: ackCompleted,
      message_ack: ackRequested ? { delivery_id: options.ackDeliveryId, status: ackStatus, lease_token_present: true } : null },
    optional_actions: { workspace_lock: workspaceLockStatus, task_workspace_lock: taskWorkspaceLockStatus, workspace_records: workspaceRecordStatus, session_cleanup: sessionCleanupStatus, session_cleanup_archive: sessionCleanupArchive, prune: pruneStatus, health_gate: healthStatus },
    optional_fail_count: optionalFails
  });
  writeState();
  if (ackRequested && !ackCompleted) {
    const ack = run("waypost", ["ack", "--delivery", options.ackDeliveryId, "--lease-token", options.ackLeaseToken]);
    if (ack.status === 0) {
      ackCompleted = true;
      ackStatus = "ok";
      if (ack.stdout || ack.stderr) process.stdout.write(ack.stdout || ack.stderr);
    } else {
      ackStatus = "failed";
      optionalFails += 1;
      notify("planner_closeout_message_ack_fail", "error", `Planner closeout ack failed: ${options.taskId}`, `Required closeout actions succeeded, but message ack failed for delivery ${options.ackDeliveryId}.`);
      if (ack.stderr || ack.stdout) process.stderr.write(ack.stderr || ack.stdout);
      process.stderr.write(`MESSAGE_ACK_FAILED: ack failed delivery='${options.ackDeliveryId}'\n`);
    }
    writeState();
  }
  if (ackRequested && !ackCompleted) workspaceReleaseBlocked = true;
  if (taskSessionIds.length > 0) {
    if (workspaceReleaseBlocked) {
      sessionCleanupStatus = "skipped_prior_optional_failure";
    } else {
      const cleanupArgs = ["--task-id", options.taskId, "--owner-session-id", plannerSessionRef, "--session-host", options.sessionHost, "--artifact-root", plannerArtifactRoot, "--apply"];
      if (options.coderSessionId) cleanupArgs.push("--target", `coder=${options.coderSessionId}`);
      if (options.reviewerSessionId) cleanupArgs.push("--target", `reviewer=${options.reviewerSessionId}`);
      if (options.architectSessionId) cleanupArgs.push("--target", `architect=${options.architectSessionId}`);
      if (options.sessionProfile) cleanupArgs.push("--profile", options.sessionProfile);
      const cleanup = invokeNodeScript(path.join(scriptDir, "archive-and-remove-task-sessions.mjs"), cleanupArgs);
      if (cleanup.stdout) process.stdout.write(cleanup.stdout);
      if (cleanup.stderr) process.stderr.write(cleanup.stderr);
      sessionCleanupArchive = path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), options.taskId, `session-archive-${options.taskId}.json`);
      const summary = cleanupArchiveSummary(sessionCleanupArchive);
      sessionCleanupStatus = cleanup.status === 0 ? summary.status : "failed";
      if (cleanup.status !== 0 || summary.warning) {
        optionalFails += 1;
        warn(`task-session cleanup incomplete status=${sessionCleanupStatus}; inspect ${sessionCleanupArchive}`);
      }
      if (cleanup.status !== 0 || summary.failed) workspaceReleaseBlocked = true;
    }
  }
  const taskArtifactRoot = path.join(taskDir, ".agent-artifacts");
  if (!workspaceReleaseBlocked) {
    const workerLock = releaseLock(workerArtifactRoot, options.taskId);
    workspaceLockStatus = workerLock.status;
    if (workerLock.failed) {
      optionalFails += 1;
      workspaceReleaseBlocked = true;
      warn(workerLock.warning);
    }
    if (sameArtifactRoot(workerArtifactRoot, taskArtifactRoot)) {
      taskWorkspaceLockStatus = "same_as_workspace";
    } else if (!workspaceReleaseBlocked) {
      const taskLock = releaseLock(taskArtifactRoot, options.taskId);
      taskWorkspaceLockStatus = taskLock.status;
      if (taskLock.failed) {
        optionalFails += 1;
        workspaceReleaseBlocked = true;
        warn(taskLock.warning);
      }
    } else {
      taskWorkspaceLockStatus = "retained_workspace_lock_failure";
    }
  } else {
    const retainedStatus = sessionCleanupStatus === "skipped_prior_optional_failure"
      ? "retained_prior_optional_failure"
      : "retained_session_cleanup_failure";
    workspaceLockStatus = retainedStatus;
    taskWorkspaceLockStatus = sameArtifactRoot(workerArtifactRoot, taskArtifactRoot)
      ? "same_as_workspace"
      : retainedStatus;
  }
  if (!workspaceReleaseBlocked) {
    const result = invokeNodeScript(path.join(scriptDir, "prepare-workspaces.mjs"), ["--worker-workspace", workerWorkspace, "--planner-workspace", plannerWorkspace, "--planner-session-id", plannerSessionRef, "--worker-artifact-root", workerArtifactRoot, "--planner-artifact-root", plannerArtifactRoot, "--release-workspaces"]);
    if (result.status === 0) workspaceRecordStatus = result.stdout.includes("status=already_absent") ? "already_absent" : "released";
    else { workspaceRecordStatus = "failed"; optionalFails += 1; warn(`failed to release mirrored workspace records rc=${result.status}; rerun prepare-workspaces.mjs --release-workspaces with the same worker/planner workspace pair`); }
  } else {
    workspaceRecordStatus = "skipped_optional_failures";
  }
  if (options.runPrune) {
    const result = invokeNodeScript(path.join(scriptDir, "prune-task-branches.mjs"), options.pruneApply ? ["--apply"] : [], { cwd: plannerWorkspace });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0) pruneStatus = "ok";
    else { pruneStatus = "failed"; optionalFails += 1; warn(`optional prune failed rc=${result.status}`); }
  }
  writeState();
  if (optionalFails > 0) {
    notify("planner_closeout_required_ok_optional_warn", "warn", `Planner closeout required actions done: ${options.taskId}`, `Required actions succeeded; ${optionalFails} optional action(s) failed.`);
    process.stdout.write(`planner_closeout_ok_with_optional_warn task_id=${options.taskId} state=${stateFile} optional_fail_count=${optionalFails}\n`);
  } else {
    notify("planner_closeout_ok", "info", `Planner closeout completed: ${options.taskId}`, "Required and optional actions completed.");
    process.stdout.write(`planner_closeout_ok task_id=${options.taskId} state=${stateFile} optional_fail_count=0\n`);
  }
}

if (isMain(import.meta.url)) execute(() => main());
