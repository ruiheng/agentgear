#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  execute, fail, isMain, nowIso, parseArgs, readJson, requireCommand, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";
import { notifyWorkflowEvent } from "./notify-workflow-event.mjs";

const usage = `Prepare worker/planner workspace records and the detached worker snapshot for one workflow.

Usage:
  prepare-workspaces.mjs [options]

Options:
  --worker-workspace <path>       Required worker/shared workspace path
  --planner-workspace <path>      Required planner closeout workspace path
  --integration-branch <ref>      Required non-task landing branch for prepare/refresh mode
  --planner-session-id <id>       Required opaque planner session id
  --supervisor-session-id <id|title> Optional supervisor session id/ref
  --worker-artifact-root <path>   Worker artifact root (default: <worker-workspace>/.agent-artifacts)
  --planner-artifact-root <path>  Planner artifact root (default: <planner-workspace>/.agent-artifacts)
  --allow-dirty                   Allow detaching worker workspace HEAD with local changes
  --release-workspaces            Delete records owned by this planner from both roots
  --override-workspaces           Replace mirrored records after explicit confirmation
  -h, --help                      Show help`;

function blocker(event, message) {
  notifyWorkflowEvent(event, "warn", "Workspace prepare blocked", message);
  fail(message);
}

function git(workspace, args) {
  return run("git", ["-C", workspace, ...args]);
}

function requireGitWorkspace(workspace) {
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) fail(`workspace does not exist: ${workspace}`);
  if (git(workspace, ["rev-parse", "--is-inside-work-tree"]).status !== 0) fail(`workspace is not inside a git repository: ${workspace}`);
  return fs.realpathSync(workspace);
}

function isTaskBranchRef(ref) {
  return /^(?:task\/|refs\/heads\/task\/|refs\/remotes\/[^/]+\/task\/)/.test(ref);
}

function integrationCommit(workspace, branch) {
  const result = git(workspace, ["rev-parse", "--verify", `${branch}^{commit}`]);
  const oid = result.status === 0 ? result.stdout.trim() : "";
  if (!oid) fail(`integration branch does not exist: ${branch}`);
  return oid;
}

function checkPlannerCloseoutWorkspace(workspace, branch) {
  if (git(workspace, ["rev-parse", "--verify", branch]).status !== 0) {
    blocker("planner_workspace_missing_integration_branch", `planner workspace '${workspace}' does not have integration branch '${branch}'; closeout would fail later, so stop during prepare`);
  }
}

function checkIntegrationBranchOwner(workerWorkspace, plannerWorkspace, integrationBranch) {
  const reference = git(workerWorkspace, ["rev-parse", "--verify", "--symbolic-full-name", integrationBranch]);
  const branchRef = reference.status === 0 ? reference.stdout.trim() : "";
  if (!branchRef.startsWith("refs/heads/")) return;
  const listed = git(workerWorkspace, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return;
  for (const record of listed.stdout.split(/\r?\n\r?\n/)) {
    const values = Object.fromEntries(record.split(/\r?\n/).filter(Boolean).map(line => {
      const divider = line.indexOf(" ");
      return divider < 0 ? [line, ""] : [line.slice(0, divider), line.slice(divider + 1)];
    }));
    if (values.worktree && values.branch === branchRef && values.worktree !== workerWorkspace && values.worktree !== plannerWorkspace) {
      blocker("workspace_branch_in_use", `integration branch '${integrationBranch}' is already checked out in worktree '${values.worktree}'; only worker workspace '${workerWorkspace}' and planner workspace '${plannerWorkspace}' may own it for this workflow`);
    }
  }
}

function ensureDetachedWorkerHead(workerWorkspace, integrationBranch, integrationCommitId, allowDirty) {
  if (!allowDirty && (git(workerWorkspace, ["diff", "--quiet"]).status !== 0 || git(workerWorkspace, ["diff", "--cached", "--quiet"]).status !== 0)) {
    blocker("worker_workspace_dirty_worktree", `dirty worker worktree/index at '${workerWorkspace}'; commit or stash first before detaching to integration commit '${integrationBranch}'`);
  }
  const currentCommit = git(workerWorkspace, ["rev-parse", "--verify", "HEAD"]);
  const currentBranch = git(workerWorkspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch.status !== 0 && currentCommit.status === 0 && currentCommit.stdout.trim() === integrationCommitId) return "matched";
  const switched = git(workerWorkspace, ["switch", "--detach", integrationCommitId]);
  if (switched.status !== 0) {
    if (switched.stderr || switched.stdout) process.stderr.write(switched.stderr || switched.stdout);
    fail(`failed to detach worker workspace '${workerWorkspace}' at integration branch '${integrationBranch}'`);
  }
  if ((switched.stderr || switched.stdout).trim()) process.stderr.write(switched.stderr || switched.stdout);
  return "detached";
}

function value(record, field) {
  return stringField(record, field);
}

function summary(filePath) {
  const record = readJson(filePath);
  return `file='${filePath}' planner_session_id='${value(record, "planner_session_id")}' integration_branch='${value(record, "integration_branch")}' supervisor_session_id='${value(record, "supervisor_session_id")}' worker_workspace='${value(record, "worker_workspace")}' planner_workspace='${value(record, "planner_workspace")}'`;
}

function mismatch(field, canonicalFile, conflictingFile, plannerSessionRef) {
  blocker("workspace_record_set_mismatch", `workspace record set mismatch: ${field} differs between mirrored records. current_planner_session='${plannerSessionRef}'. canonical { ${summary(canonicalFile)} }. conflicting { ${summary(conflictingFile)} }. If you intend to replace both mirrored records for this planner, rerun with --override-workspaces after explicit user confirmation.`);
}

function validateRecordSet(canonicalFile, recordFiles, plannerSessionRef) {
  const canonical = readJson(canonicalFile);
  for (const filePath of recordFiles) {
    if (filePath === canonicalFile || !fs.existsSync(filePath)) continue;
    const record = readJson(filePath);
    for (const field of ["planner_session_id", "integration_branch", "supervisor_session_id"]) {
      if (value(record, field) !== value(canonical, field)) mismatch(field, canonicalFile, filePath, plannerSessionRef);
    }
    for (const field of ["worker_workspace", "planner_workspace"]) {
      if (value(record, field) || value(canonical, field)) {
        if (value(record, field) !== value(canonical, field)) mismatch(field, canonicalFile, filePath, plannerSessionRef);
      }
    }
  }
}

function writeRecord(filePath, { plannerSessionId, integrationBranch, supervisorSessionId, workerWorkspace, plannerWorkspace, status }) {
  const updatedAt = nowIso();
  const record = {
    planner_session_id: plannerSessionId,
    integration_branch: integrationBranch,
    worker_workspace: workerWorkspace,
    planner_workspace: plannerWorkspace,
    updated_at: updatedAt
  };
  if (supervisorSessionId) record.supervisor_session_id = supervisorSessionId;
  if (status === "created") record.created_at = updatedAt;
  writeJsonAtomic(filePath, record);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--worker-workspace", "--planner-workspace", "--integration-branch", "--planner-session-id", "--supervisor-session-id", "--worker-artifact-root", "--planner-artifact-root"],
    flags: ["--allow-dirty", "--release-workspaces", "--release-planner-workspace", "--override-workspaces", "--override-planner-workspace"],
    defaults: {
      workerWorkspace: "", plannerWorkspace: "", integrationBranch: "", plannerSessionId: "", supervisorSessionId: "", workerArtifactRoot: "", plannerArtifactRoot: "",
      allowDirty: false, releaseWorkspaces: false, releasePlannerWorkspace: false, overrideWorkspaces: false, overridePlannerWorkspace: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.workerWorkspace) fail("--worker-workspace is required");
  if (!options.plannerWorkspace) fail("--planner-workspace is required");
  if (!options.plannerSessionId) fail("--planner-session-id is required");
  const release = options.releaseWorkspaces || options.releasePlannerWorkspace;
  const override = options.overrideWorkspaces || options.overridePlannerWorkspace;
  if (release && override) fail("--release-workspaces cannot be combined with --override-workspaces");
  if (!release && !options.integrationBranch) fail("--integration-branch is required");
  if (release && options.integrationBranch) fail("--integration-branch is not allowed with --release-workspaces");
  if (release && options.supervisorSessionId) fail("--supervisor-session-id is not allowed with --release-workspaces");
  if (release && options.allowDirty) fail("--allow-dirty is not allowed with --release-workspaces");
  requireCommand("git");
  const workerWorkspace = requireGitWorkspace(options.workerWorkspace);
  const plannerWorkspace = requireGitWorkspace(options.plannerWorkspace);
  const workerArtifactRoot = options.workerArtifactRoot || path.join(workerWorkspace, ".agent-artifacts");
  const plannerArtifactRoot = options.plannerArtifactRoot || path.join(plannerWorkspace, ".agent-artifacts");
  const workerRecord = path.join(workerArtifactRoot.replace(/[\\/]+$/, ""), "planner-workspace.json");
  const plannerRecord = path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), "planner-workspace.json");
  const recordFiles = [...new Set([workerRecord, plannerRecord])];
  const plannerSessionId = options.plannerSessionId;

  const releaseMatches = filePath => {
    const record = readJson(filePath);
    const recordPlanner = value(record, "planner_session_id");
    if (!recordPlanner) fail(`workspace record missing planner_session_id: ${filePath}`);
    if (recordPlanner !== plannerSessionId) fail(`workspace record planner mismatch: record='${recordPlanner}' expected='${plannerSessionId}' file='${filePath}'`);
    if (value(record, "worker_workspace") !== workerWorkspace) fail(`workspace record worker path mismatch: record='${value(record, "worker_workspace")}' expected='${workerWorkspace}' file='${filePath}'`);
    if (value(record, "planner_workspace") !== plannerWorkspace) fail(`workspace record planner path mismatch: record='${value(record, "planner_workspace")}' expected='${plannerWorkspace}' file='${filePath}'`);
  };

  if (release) {
    for (const filePath of recordFiles) if (fs.existsSync(filePath)) releaseMatches(filePath);
    let removed = false;
    for (const filePath of recordFiles) {
      if (!fs.existsSync(filePath)) continue;
      fs.rmSync(filePath, { force: true });
      removed = true;
    }
    process.stdout.write(`workspaces_prepared status=${removed ? "released" : "already_absent"} worker_record=${workerRecord} planner_record=${plannerRecord} planner=${plannerSessionId}\n`);
    return;
  }

  if (isTaskBranchRef(options.integrationBranch)) fail(`--integration-branch must be a non-task landing branch, got: ${options.integrationBranch}`);
  const commit = integrationCommit(workerWorkspace, options.integrationBranch);
  checkPlannerCloseoutWorkspace(plannerWorkspace, options.integrationBranch);
  checkIntegrationBranchOwner(workerWorkspace, plannerWorkspace, options.integrationBranch);
  const existing = recordFiles.filter(filePath => fs.existsSync(filePath));
  const missingRecord = existing.length !== recordFiles.length;
  const writeSet = status => recordFiles.forEach(filePath => writeRecord(filePath, {
    plannerSessionId, integrationBranch: options.integrationBranch, supervisorSessionId: options.supervisorSessionId,
    workerWorkspace, plannerWorkspace, status
  }));
  const output = (status, checkoutStatus) => {
    process.stdout.write("worker workspace git state: detached HEAD\n");
    process.stdout.write(`workspaces_prepared status=${status} checkout_status=${checkoutStatus} worker_record=${workerRecord} planner_record=${plannerRecord} planner=${plannerSessionId} integration_branch=${options.integrationBranch} integration_commit=${commit} worker_workspace=${workerWorkspace} planner_workspace=${plannerWorkspace}\n`);
  };
  if (override || existing.length === 0) {
    const checkout = ensureDetachedWorkerHead(workerWorkspace, options.integrationBranch, commit, options.allowDirty);
    writeSet(override ? "overridden" : "created");
    output(override ? "overridden" : "created", checkout);
    return;
  }
  const canonicalFile = existing[0];
  validateRecordSet(canonicalFile, recordFiles, plannerSessionId);
  const record = readJson(canonicalFile);
  const recordPlannerId = value(record, "planner_session_id");
  if (recordPlannerId !== plannerSessionId) fail(`workspace record planner mismatch: record='${recordPlannerId}' expected='${plannerSessionId}' file='${canonicalFile}'; use --override-workspaces only after explicit confirmation`);
  if (value(record, "integration_branch") !== options.integrationBranch) fail(`workspace record integration branch mismatch: record='${value(record, "integration_branch")}' expected='${options.integrationBranch}' file='${canonicalFile}'`);
  if (value(record, "supervisor_session_id") && options.supervisorSessionId && value(record, "supervisor_session_id") !== options.supervisorSessionId) fail(`workspace record supervisor mismatch: record='${value(record, "supervisor_session_id")}' expected='${options.supervisorSessionId}' file='${canonicalFile}'`);
  if (value(record, "worker_workspace") && value(record, "worker_workspace") !== workerWorkspace) fail(`workspace record worker path mismatch: record='${value(record, "worker_workspace")}' expected='${workerWorkspace}' file='${canonicalFile}'`);
  if (value(record, "planner_workspace") && value(record, "planner_workspace") !== plannerWorkspace) fail(`workspace record planner path mismatch: record='${value(record, "planner_workspace")}' expected='${plannerWorkspace}' file='${canonicalFile}'`);
  const needsRefresh = (options.supervisorSessionId && value(record, "supervisor_session_id") !== options.supervisorSessionId) || !value(record, "worker_workspace") || !value(record, "planner_workspace") || missingRecord;
  const checkout = ensureDetachedWorkerHead(workerWorkspace, options.integrationBranch, commit, options.allowDirty);
  if (needsRefresh) {
    writeSet("matched_refreshed");
    output("matched_refreshed", checkout);
  } else {
    output("matched", checkout);
  }
}

if (isMain(import.meta.url)) execute(() => main());
