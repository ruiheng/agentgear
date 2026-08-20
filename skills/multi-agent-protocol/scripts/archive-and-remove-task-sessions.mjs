#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { cleanupSessionTargets } from "../../../providers/session-cleanup.mjs";
import { execute, fail, isMain, nowIso, parseArgs, writeJsonAtomic } from "./workflow-lib.mjs";

const usage = `Archive task-session metadata, including provider resume ids when available, then optionally remove task-scoped disposable sessions.

Usage:
  archive-and-remove-task-sessions.mjs [options]

Options:
  --task-id <id>                    Required task id (YYYYMMDD-HHMM-<slug>)
  --owner-session-id <id>           Cleanup owner session id
  --target <role>=<session-id>      Exact cleanup target; repeat for each session
  --session-host <host>             Session host (default: agent-deck)
  --artifact-root <path>            Artifact root (default: .agent-artifacts)
  --profile <name>                  Agent Deck profile
  --apply                            Remove disposable sessions after archiving
  -h, --help                        Show help

Legacy compatibility:
  --planner-session-id, --coder-session-id, --reviewer-session-id, and
  --architect-session-id are accepted temporarily and normalized to the
  generic owner/target model. Do not combine a legacy target with --target
  for the same role.

Targets are eligible only when the provider reports the task-scoped title
<role>-<task-id>. The historical reviewer-task-...-<task-id> form remains
eligible for compatibility.`;

function disposable(role, title, taskId) {
  if (!title) return false;
  if (title === `${role}-${taskId}`) return true;
  if (role !== "reviewer") return false;
  return new RegExp(`^reviewer-task-.+-${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(title);
}

function parseTarget(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail(`invalid --target ${JSON.stringify(value)}; expected <role>=<session-id>`);
  const role = value.slice(0, separator);
  const ref = value.slice(separator + 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) fail(`invalid cleanup target role: ${role}`);
  return { role, ref };
}

function resolveTargets(options) {
  const targets = (options.target || []).map(parseTarget);
  const seenTargets = new Set();
  const genericRoles = new Set();
  for (const target of targets) {
    const key = `${target.role}\0${target.ref}`;
    if (seenTargets.has(key)) fail(`duplicate cleanup target: ${target.role}=${target.ref}`);
    seenTargets.add(key);
    genericRoles.add(target.role);
  }
  const legacyTargets = [
    ["coder", options.coderSessionId],
    ["reviewer", options.reviewerSessionId],
    ["architect", options.architectSessionId]
  ].filter(([, ref]) => Boolean(ref));
  for (const [role, ref] of legacyTargets) {
    if (genericRoles.has(role)) fail(`cleanup target role ${role} was supplied by both --target and a legacy option`);
    targets.push({ role, ref });
  }
  if (targets.length > 0) return targets;
  return ["coder", "reviewer", "architect"].map(role => ({ role, ref: `${role}-${options.taskId}` }));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--task-id", "--owner-session-id", "--planner-session-id", "--coder-session-id", "--reviewer-session-id", "--architect-session-id", "--session-host", "--artifact-root", "--profile"],
    repeatableValues: ["--target"],
    flags: ["--apply"],
    defaults: {
      taskId: "", ownerSessionId: "", plannerSessionId: "", coderSessionId: "", reviewerSessionId: "", architectSessionId: "",
      target: [], sessionHost: "agent-deck", artifactRoot: ".agent-artifacts", profile: "", apply: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.taskId) fail("--task-id is required");
  if (options.ownerSessionId && options.plannerSessionId && options.ownerSessionId !== options.plannerSessionId) {
    fail("--owner-session-id and --planner-session-id must identify the same session when both are supplied");
  }
  const ownerSessionId = options.ownerSessionId || options.plannerSessionId;
  const targets = resolveTargets(options);
  const artifactDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), options.taskId);
  const archiveFile = path.join(artifactDir, `session-archive-${options.taskId}.json`);
  const result = cleanupSessionTargets({
    taskId: options.taskId,
    ownerSessionId,
    targets,
    sessionHost: options.sessionHost,
    profile: options.profile,
    apply: options.apply,
    isDisposable: disposable
  });
  for (const line of result.output) process.stdout.write(`${line}\n`);
  writeJsonAtomic(archiveFile, {
    task_id: options.taskId,
    archived_at: nowIso(),
    mode: result.mode,
    session_host: result.sessionHost,
    owner_session_ref: result.ownerSessionRef,
    owner_session_id: result.ownerSessionId,
    owner_session_group: result.ownerSessionGroup,
    planner_session_ref: result.ownerSessionRef,
    planner_session_id: result.ownerSessionId,
    planner_session_group: result.ownerSessionGroup,
    profile_name: result.profileName,
    state_db_path: result.stateDatabasePath,
    sessions: result.sessions,
    group_cleanup: result.groupCleanup
  });
  process.stdout.write(`archive_ok file=${archiveFile} mode=${options.apply ? "apply" : "preview"}\n`);
  if (result.blocked > 0) {
    const blockReasons = [...new Set(result.sessions
      .filter(session => session.delete_status.startsWith("blocked_"))
      .map(session => session.delete_block_reason)
      .filter(Boolean))];
    process.stdout.write(`delete_guard_blocked count=${result.blocked} reason=${blockReasons.join(",") || "guard_failed"}\n`);
    process.stdout.write("delete_guard_action=manual_close_required\n");
    process.stdout.write("delete_guard_hint inspect the archive delete_block_reason before rerunning cleanup\n");
  }
  if (result.failed > 0) process.stdout.write(`delete_failed count=${result.failed}\n`);
  if (result.blocked > 0 || result.failed > 0) process.exitCode = 3;
}

if (isMain(import.meta.url)) execute(() => main());
