#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  agentDeckArgs, commandJson, currentScriptDirectory, execute, fail, isMain, nowIso, parseArgs, resolveCommand, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

const usage = `Archive task-session resume metadata, then optionally remove coder/reviewer/architect sessions.

Usage:
  archive-and-remove-task-sessions.mjs [options]

Options:
  --task-id <id>                    Required task id (YYYYMMDD-HHMM-<slug>)
  --planner-session-id <id|title>   Planner session ref (default: current agent-deck session id)
  --coder-session-id <id|title>     Coder session ref (default: coder-<task-id>)
  --reviewer-session-id <id|title>  Reviewer session ref (default: reviewer-<task-id>)
  --architect-session-id <id|title> Architect session ref (default: architect-<task-id>)
  --session-host <host>             Session host (default: agent-deck)
  --artifact-root <path>            Artifact root (default: .agent-artifacts)
  --profile <name>                  Agent-deck profile
  --apply                            Remove disposable sessions after archiving
  -h, --help                        Show help

Agent Deck deletion is guarded for Codex, Claude, Gemini, and OpenCode
sessions: their matching provider resume id must be recorded first. Thurbox
uses exact id/name checks and recoverable soft-delete; it never uses --force.`;

function debug(message) {
  if (process.env.ADWF_DEBUG === "1") process.stderr.write(`DEBUG: ${message}\n`);
}

function expectedProviderKey(tool) {
  return {
    codex: "codex_session_id",
    claude: "claude_session_id",
    "claude-code": "claude_session_id",
    gemini: "gemini_session_id",
    "gemini-cli": "gemini_session_id",
    opencode: "opencode_session_id"
  }[tool] || "";
}

function providerIdsFromObject(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const allowed = ["claude_session_id", "gemini_session_id", "opencode_session_id", "codex_session_id", "claude_detected_at", "gemini_detected_at", "opencode_detected_at", "codex_detected_at"];
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined && source[key] !== null && source[key] !== "").map(key => [key, source[key]]));
}

function providerIdsFromStateDatabase(sessionId, databasePath) {
  const sqlite = resolveCommand("sqlite3");
  if (!sqlite || !sessionId || !databasePath || !fs.existsSync(databasePath)) return {};
  const escapedId = sessionId.replaceAll("'", "''");
  const query = `SELECT tool_data FROM instances WHERE id = '${escapedId}' LIMIT 1;`;
  const result = run(sqlite, ["-batch", "-noheader", databasePath, query]);
  if (result.status !== 0 || !result.stdout.trim()) {
    debug(`provider_id_source=db session_id=${sessionId} result=empty`);
    return {};
  }
  try {
    const ids = providerIdsFromObject(JSON.parse(result.stdout));
    debug(`provider_id_source=db session_id=${sessionId} result=${Object.keys(ids).length ? "ok" : "empty"}`);
    return ids;
  } catch {
    debug(`provider_id_source=db session_id=${sessionId} result=invalid_json`);
    return {};
  }
}

function agentDeckDataRoots(env = process.env) {
  const home = env.HOME || os.homedir() || process.cwd();
  const xdgDataHome = env.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(home, ".local", "share");
  const roots = [
    path.join(xdgDataHome, "agent-deck"),
    path.join(home, ".agent-deck")
  ];
  return [...new Set(roots)];
}

function selectAgentDeckDataRoot(profileName, env = process.env) {
  const roots = agentDeckDataRoots(env);
  const [xdgRoot, legacyRoot] = roots;
  const xdgDatabase = path.join(xdgRoot, "profiles", profileName, "state.db");
  const legacyDatabase = path.join(legacyRoot, "profiles", profileName, "state.db");

  // Agent Deck v1.9.49+ uses the XDG root. Prefer it whenever it has been
  // initialized, including a root that only contains hook metadata. Fall
  // back to the legacy root only when the XDG root is absent.
  if (fs.existsSync(xdgDatabase) || fs.existsSync(xdgRoot)) return xdgRoot;
  if (fs.existsSync(legacyDatabase) || fs.existsSync(legacyRoot)) return legacyRoot;
  return xdgRoot;
}

function providerIdsFromHook(sessionId, tool, dataRoot) {
  const expected = expectedProviderKey(tool);
  if (!sessionId || !expected) return {};
  const filePath = path.join(dataRoot, "hooks", `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return {};
  try {
    const hook = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const providerSessionId = stringField(hook, "session_id");
    if (!providerSessionId) return {};
    const detectedKey = expected.replace(/_session_id$/, "_detected_at");
    const ids = { [expected]: providerSessionId };
    if (/^\d+$/.test(String(hook.ts ?? ""))) ids[detectedKey] = Number(hook.ts);
    debug(`provider_id_source=hook session_id=${sessionId} result=ok`);
    return ids;
  } catch {
    debug(`provider_id_source=hook session_id=${sessionId} result=invalid_json`);
    return {};
  }
}

function disposable(role, title, taskId) {
  if (!title) return false;
  if (role !== "reviewer") return title === `${role}-${taskId}`;
  return title === `reviewer-${taskId}` || new RegExp(`^reviewer-task-.+-${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(title);
}

function flattenGroups(groups) {
  const result = [];
  const visit = group => {
    if (!group || typeof group !== "object") return;
    result.push(group);
    for (const child of Array.isArray(group.children) ? group.children : []) visit(child);
  };
  for (const group of Array.isArray(groups) ? groups : []) visit(group);
  return result;
}

function deleteThroughAgentgear(host, sessionId, profile = "") {
  const agentgear = path.resolve(currentScriptDirectory(import.meta.url), "../../../bin/agentgear.mjs");
  if (!fs.statSync(agentgear, { throwIfNoEntry: false })?.isFile()) fail(`agentgear CLI not found: ${agentgear}`);
  const args = [agentgear, "session", "delete", "--host", host, "--session-id", sessionId, "--json"];
  if (profile) args.push("--profile", profile);
  const result = run(process.execPath, args);
  let payload = null;
  if (result.stdout.trim()) {
    try { payload = JSON.parse(result.stdout); } catch { /* Report malformed CLI output below. */ }
  }
  const error = payload?.error || (result.status === 0 && payload ? null : {
    message: result.status === 0
      ? "agentgear session delete returned invalid JSON"
      : result.stderr.trim() || result.stdout.trim() || `agentgear session delete exited with status ${result.status}`,
    exit_code: result.status
  });
  return { result, payload, error };
}

function deleteProviderRecord(deletion) {
  return {
    command: deletion.payload?.provider_command || null,
    stdout: deletion.payload?.provider_stdout ?? deletion.result.stdout,
    stderr: deletion.payload?.provider_stderr ?? deletion.result.stderr
  };
}

function thurboxSessionInventory() {
  const result = run("thurbox-cli", ["session", "list", "--json"]);
  if (result.error || result.status !== 0) {
    fail(`failed to query Thurbox sessions: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    fail("failed to parse Thurbox session list JSON");
  }
  const sessions = Array.isArray(payload) ? payload : payload?.sessions;
  if (!Array.isArray(sessions)) fail("Thurbox session list JSON has no sessions array");
  return sessions;
}

function thurboxUuid(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function thurboxSessionByUuid(uuid) {
  const result = run("thurbox-cli", ["session", "get", uuid, "--json"]);
  if (result.error) fail(`failed to query Thurbox session ${uuid}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    if (result.status === 1 && /session not found/i.test(detail)) return null;
    fail(`failed to query Thurbox session ${uuid}: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    fail(`failed to parse Thurbox session JSON for ${uuid}`);
  }
  const session = payload?.session && typeof payload.session === "object" ? payload.session : payload;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    fail(`Thurbox session JSON has no session object for ${uuid}`);
  }
  return session;
}

function archiveThurboxSessions(options, roleRefs, archiveFile) {
  if (!resolveCommand("thurbox-cli")) fail("thurbox-cli not found in PATH");
  if (!options.plannerSessionId) fail("--planner-session-id is required for Thurbox cleanup");
  const inventory = thurboxSessionInventory();
  const entries = [];
  let failed = 0;
  for (const [role, ref] of roleRefs) {
    const listed = inventory.find(session => [
      stringField(session, "uuid"), stringField(session, "id"),
      stringField(session, "name"), stringField(session, "title")
    ].includes(ref)) || null;
    const shown = listed || (thurboxUuid(ref) ? thurboxSessionByUuid(ref) : null);
    const id = stringField(shown, "uuid") || stringField(shown, "id");
    const title = stringField(shown, "name") || stringField(shown, "title");
    const deleteEligible = disposable(role, title, options.taskId);
    let deleted = false;
    let deleteStatus = "not_found";
    let deleteError = null;
    let deleteProvider = null;
    if (id) {
      if (!options.apply) deleteStatus = "skipped_no_apply";
      else if (!deleteEligible) {
        deleteStatus = "skipped_non_disposable_session";
        process.stdout.write(`session_preserved role=${role} ref=${ref} id=${id} title=${title} reason=non_disposable_session\n`);
      } else {
        const removed = deleteThroughAgentgear("thurbox", id);
        deleteProvider = deleteProviderRecord(removed);
        if (removed.result.status === 0 && removed.payload?.status === "deleted") {
          deleteStatus = "deleted";
          deleted = true;
        } else {
          deleteStatus = "delete_failed";
          deleteError = removed.error;
          failed += 1;
        }
      }
    }
    entries.push({
      role,
      ref,
      found: Boolean(id),
      session_host: "thurbox",
      session_id: id || null,
      session_title: title || null,
      path: stringField(shown, "cwd") || stringField(shown, "repo_path") || stringField(shown, "path") || null,
      parent_session_id: stringField(shown, "parent_session_id") || stringField(shown, "parent") || stringField(shown, "parent_id") || null,
      delete_eligible: deleteEligible,
      delete_applied: options.apply,
      delete_mode: "soft-delete",
      recoverable: true,
      deleted,
      delete_status: deleteStatus,
      delete_block_reason: deleteStatus === "skipped_non_disposable_session" ? "non_disposable_session" : null,
      delete_error: deleteError,
      delete_provider: deleteProvider,
      session_get: shown
    });
    process.stdout.write(`session role=${role} ref=${ref} found=${id ? 1 : 0}${id ? ` id=${id}` : ""} delete_status=${deleteStatus}\n`);
  }
  writeJsonAtomic(archiveFile, {
    task_id: options.taskId,
    archived_at: nowIso(),
    mode: options.apply ? "archive_and_remove" : "archive_only",
    session_host: "thurbox",
    planner_session_ref: options.plannerSessionId,
    planner_session_id: options.plannerSessionId,
    planner_session_group: null,
    profile_name: null,
    state_db_path: null,
    sessions: entries,
    group_cleanup: []
  });
  process.stdout.write(`archive_ok file=${archiveFile} mode=${options.apply ? "apply" : "preview"}\n`);
  if (failed > 0) {
    process.stdout.write(`delete_failed count=${failed}\n`);
    process.exitCode = 3;
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--task-id", "--planner-session-id", "--coder-session-id", "--reviewer-session-id", "--architect-session-id", "--session-host", "--artifact-root", "--profile"],
    flags: ["--apply"],
    defaults: { taskId: "", plannerSessionId: "", coderSessionId: "", reviewerSessionId: "", architectSessionId: "", sessionHost: "agent-deck", artifactRoot: ".agent-artifacts", profile: "", apply: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.taskId) fail("--task-id is required");
  const explicitRoleRefs = [
    ["coder", options.coderSessionId],
    ["reviewer", options.reviewerSessionId],
    ["architect", options.architectSessionId]
  ].filter(([, ref]) => Boolean(ref));
  const roleRefs = explicitRoleRefs.length > 0 ? explicitRoleRefs : [
    ["coder", `coder-${options.taskId}`],
    ["reviewer", `reviewer-${options.taskId}`],
    ["architect", `architect-${options.taskId}`]
  ];
  const artifactDir = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), options.taskId);
  const archiveFile = path.join(artifactDir, `session-archive-${options.taskId}.json`);
  if (options.sessionHost === "thurbox") {
    archiveThurboxSessions(options, roleRefs, archiveFile);
    return;
  }
  if (options.sessionHost !== "agent-deck") {
    writeJsonAtomic(archiveFile, {
      task_id: options.taskId,
      archived_at: nowIso(),
      mode: "preserve_unsupported_host",
      session_host: options.sessionHost,
      planner_session_ref: options.plannerSessionId || null,
      planner_session_id: null,
      planner_session_group: null,
      profile_name: null,
      state_db_path: null,
      sessions: roleRefs.map(([role, ref]) => ({
        role,
        ref,
        found: null,
        delete_applied: false,
        deleted: false,
        delete_status: "preserved_unsupported_host",
        delete_block_reason: "unsupported_host"
      })),
      group_cleanup: []
    });
    process.stdout.write(`session_cleanup_preserved host=${options.sessionHost} reason=unsupported_host archive=${archiveFile}\n`);
    return;
  }
  if (!resolveCommand("agent-deck")) fail("agent-deck not found in PATH");
  const ad = args => run("agent-deck", agentDeckArgs(options.profile, args));
  const adJson = args => commandJson("agent-deck", agentDeckArgs(options.profile, args));
  const current = commandJson("agent-deck", agentDeckArgs(options.profile, ["session", "current", "--json"]));
  if (!options.plannerSessionId) {
    options.plannerSessionId = stringField(current, "id");
    if (!options.plannerSessionId) fail("failed to resolve current agent-deck session id; pass --planner-session-id");
  }
  const profileName = options.profile || stringField(current, "profile") || "default";
  const dataRoot = selectAgentDeckDataRoot(profileName);
  const databasePath = path.join(dataRoot, "profiles", profileName, "state.db");
  if (!fs.existsSync(databasePath)) debug(`provider_id_source=db result=state_db_missing profile=${profileName}`);
  const planner = adJson(["session", "show", options.plannerSessionId, "--json"]);
  const plannerId = stringField(planner, "id");
  const plannerGroup = stringField(planner, "group");
  const candidateGroups = new Set();
  let blocked = 0;
  let failed = 0;
  const entries = [];

  for (const [role, ref] of roleRefs) {
    const shown = adJson(["session", "show", ref, "--json"]);
    const id = stringField(shown, "id");
    const title = stringField(shown, "title");
    const tool = stringField(shown, "tool");
    const expected = expectedProviderKey(tool);
    let ids = providerIdsFromStateDatabase(id, databasePath);
    let providerSource = "state_db_tool_data";
    if (expected && !ids[expected]) {
      const hookIds = providerIdsFromHook(id, tool, dataRoot);
      if (hookIds[expected]) {
        ids = { ...ids, ...hookIds };
        providerSource = Object.keys(ids).length > Object.keys(hookIds).length ? "state_db_tool_data+hook_status_file" : "hook_status_file";
      }
    }
    const guardRequired = Boolean(expected);
    const guardPassed = !guardRequired || Boolean(ids[expected]);
    const deleteEligible = disposable(role, title, options.taskId);
    let deleted = false;
    let deleteStatus;
    let deleteBlockReason = "";
    let deleteError = null;
    let deleteProvider = null;
    if (!id) {
      deleteStatus = "not_found";
      entries.push({
        role, ref, found: false, tool: tool || null, provider_resume_ids: ids,
        has_provider_resume_id: Object.keys(ids).some(key => key.endsWith("_session_id")), provider_guard_expected_key: expected || null,
        provider_guard_required: guardRequired, provider_guard_passed: guardPassed, delete_eligible: deleteEligible,
        provider_resume_source: providerSource, raw_session_show: shown ? JSON.stringify(shown) : null,
        delete_applied: options.apply, deleted: false, delete_status: deleteStatus, delete_block_reason: null
      });
      process.stdout.write(`session role=${role} ref=${ref} found=0 delete_status=${deleteStatus}\n`);
      continue;
    }
    if (!options.apply) deleteStatus = "skipped_no_apply";
    else if (!deleteEligible) {
      deleteStatus = "skipped_non_disposable_session";
      deleteBlockReason = "non_disposable_session";
      process.stdout.write(`session_preserved role=${role} ref=${ref} id=${id} title=${title} reason=${deleteBlockReason}\n`);
    } else if (!guardPassed) {
      deleteStatus = "blocked_missing_provider_session_id";
      deleteBlockReason = "missing_provider_session_id";
      blocked += 1;
      process.stdout.write(`manual_close_required role=${role} ref=${ref} id=${id} tool=${tool} expected_key=${expected} reason=${deleteBlockReason}\n`);
      process.stdout.write(`manual_close_suggestion command='agent-deck remove ${id}'\n`);
    } else {
      const removed = deleteThroughAgentgear("agent-deck", id, options.profile);
      deleteProvider = deleteProviderRecord(removed);
      if (removed.result.status === 0 && removed.payload?.status === "deleted") {
        deleteStatus = "deleted";
        deleted = true;
        const sessionGroup = stringField(shown, "group");
        if (plannerGroup && sessionGroup.startsWith(`${plannerGroup}/`)) {
          const root = `${plannerGroup}/${sessionGroup.slice(plannerGroup.length + 1).split("/")[0]}`;
          let group = sessionGroup;
          while (group === root || group.startsWith(`${root}/`)) {
            candidateGroups.add(group);
            if (group === root) break;
            group = group.slice(0, group.lastIndexOf("/"));
          }
        }
      } else {
        deleteStatus = "delete_failed";
        deleteError = removed.error;
        failed += 1;
      }
    }
    entries.push({
      role, ref, found: true, agent_deck_session_id: id, session_title: title, tool: tool || null, status: stringField(shown, "status") || null,
      group: stringField(shown, "group") || null, path: stringField(shown, "path") || null, provider_resume_ids: ids,
      has_provider_resume_id: Object.keys(ids).some(key => key.endsWith("_session_id")), provider_guard_expected_key: expected || null,
      provider_guard_required: guardRequired, provider_guard_passed: guardPassed, delete_eligible: deleteEligible,
      provider_resume_source: providerSource, session_show: shown, delete_applied: options.apply, deleted, delete_status: deleteStatus,
      delete_block_reason: deleteBlockReason || null, delete_error: deleteError, delete_provider: deleteProvider
    });
    process.stdout.write(`session role=${role} ref=${ref} found=1 id=${id} delete_status=${deleteStatus}\n`);
  }

  const groupCleanup = [];
  if (options.apply && candidateGroups.size > 0) {
    for (const groupPath of [...candidateGroups].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
      const groups = adJson(["group", "list", "--json"]);
      const allGroups = flattenGroups(groups?.groups);
      if (!allGroups.some(group => stringField(group, "path") === groupPath)) {
        groupCleanup.push({ group: groupPath, delete_status: "already_absent", session_count: 0, descendant_group_count: 0, delete_error: null });
        process.stdout.write(`group_cleanup group=${groupPath} delete_status=already_absent\n`);
        continue;
      }
      const inventory = adJson(["list", "--json"]);
      if (!Array.isArray(inventory) || !groups) {
        groupCleanup.push({ group: groupPath, delete_status: "check_failed", session_count: 0, descendant_group_count: 0, delete_error: "failed to inspect group occupancy" });
        process.stdout.write(`group_cleanup group=${groupPath} delete_status=check_failed\n`);
        continue;
      }
      const sessionCount = inventory.filter(session => {
        const sessionGroup = stringField(session, "group");
        return sessionGroup === groupPath || sessionGroup.startsWith(`${groupPath}/`);
      }).length;
      const descendants = allGroups.filter(groupEntry => {
        const candidatePath = stringField(groupEntry, "path");
        return candidatePath !== groupPath && candidatePath.startsWith(`${groupPath}/`);
      }).length;
      if (sessionCount > 0 || descendants > 0) {
        const status = sessionCount > 0 ? "blocked_nonempty" : "blocked_descendant_groups";
        groupCleanup.push({ group: groupPath, delete_status: status, session_count: sessionCount, descendant_group_count: descendants, delete_error: null });
        process.stdout.write(`group_cleanup group=${groupPath} delete_status=${status}${sessionCount > 0 ? ` session_count=${sessionCount}` : ` descendant_group_count=${descendants}`}\n`);
        continue;
      }
      const removed = ad(["group", "delete", groupPath]);
      const status = removed.status === 0 ? "deleted" : "delete_failed";
      groupCleanup.push({ group: groupPath, delete_status: status, session_count: sessionCount, descendant_group_count: descendants, delete_error: status === "deleted" ? null : (removed.stderr || removed.stdout).trim() || null });
      process.stdout.write(`group_cleanup group=${groupPath} delete_status=${status}\n`);
    }
  }
  writeJsonAtomic(archiveFile, {
    task_id: options.taskId, archived_at: nowIso(), mode: options.apply ? "archive_and_remove" : "archive_only",
    session_host: options.sessionHost,
    planner_session_ref: options.plannerSessionId, planner_session_id: plannerId || null, planner_session_group: plannerGroup || null,
    profile_name: profileName, state_db_path: fs.existsSync(databasePath) ? databasePath : null, sessions: entries, group_cleanup: groupCleanup
  });
  process.stdout.write(`archive_ok file=${archiveFile} mode=${options.apply ? "apply" : "preview"}\n`);
  if (blocked > 0) {
    process.stdout.write(`delete_guard_blocked count=${blocked} reason=missing_provider_session_id\n`);
    process.stdout.write("delete_guard_action=manual_close_required\n");
    process.stdout.write("delete_guard_hint set ADWF_DEBUG=1 and rerun for provider-id source diagnostics\n");
  }
  if (failed > 0) {
    process.stdout.write(`delete_failed count=${failed}\n`);
  }
  if (blocked > 0 || failed > 0) {
    process.exitCode = 3;
  }
}

if (isMain(import.meta.url)) execute(() => main());
