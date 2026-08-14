import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { deleteSession } from "../cli/lib/session-hosts.mjs";
import {
  agentDeckArgs, commandJson, fail, resolveCommand, run, stringField
} from "../skills/multi-agent-protocol/scripts/workflow-lib.mjs";

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
  const result = run(sqlite, ["-batch", "-noheader", databasePath, `SELECT tool_data FROM instances WHERE id = '${escapedId}' LIMIT 1;`]);
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

function agentDeckDataRoot(profileName, env = process.env) {
  const home = env.HOME || os.homedir() || process.cwd();
  const xdgDataHome = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  const xdgRoot = path.join(xdgDataHome, "agent-deck");
  const legacyRoot = path.join(home, ".agent-deck");
  if (fs.existsSync(path.join(xdgRoot, "profiles", profileName, "state.db")) || fs.existsSync(xdgRoot)) return xdgRoot;
  if (fs.existsSync(path.join(legacyRoot, "profiles", profileName, "state.db")) || fs.existsSync(legacyRoot)) return legacyRoot;
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

function deleteProviderRecord(payload) {
  return {
    command: payload.provider_command || null,
    stdout: payload.provider_stdout || "",
    stderr: payload.provider_stderr || ""
  };
}

function thurboxInventory() {
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

function thurboxSessionByUuid(uuid) {
  const result = run("thurbox-cli", ["session", "get", "--json", uuid]);
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
  if (!session || typeof session !== "object" || Array.isArray(session)) fail(`Thurbox session JSON has no session object for ${uuid}`);
  return session;
}

function isThurboxUuid(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function cleanupThurbox(options) {
  if (!resolveCommand("thurbox-cli")) fail("thurbox-cli not found in PATH");
  if (!options.ownerSessionId) fail("--owner-session-id is required for Thurbox cleanup");
  thurboxInventory(); // Fail closed if the provider inventory is unavailable.
  const sessions = [];
  const output = [];
  let blocked = 0;
  let failed = 0;
  for (const target of options.targets) {
    const targetIsUuid = isThurboxUuid(target.ref);
    const shown = targetIsUuid ? thurboxSessionByUuid(target.ref) : null;
    const id = stringField(shown, "id");
    const exactId = isThurboxUuid(id) && id === target.ref;
    const title = stringField(shown, "name") || stringField(shown, "title");
    const parentSessionId = stringField(shown, "parent_session_id");
    const deleteEligible = options.isDisposable(target.role, title, options.taskId);
    let deleted = false;
    let deleteStatus = "not_found";
    let deleteBlockReason = null;
    let deleteError = null;
    let deleteProvider = null;
    let deleteMode = "soft-delete";
    let recoverable = true;
    if (!targetIsUuid) {
      deleteStatus = "blocked_invalid_session_id";
      deleteBlockReason = "invalid_session_id";
      blocked += 1;
      output.push(`session_preserved role=${target.role} ref=${target.ref} reason=${deleteBlockReason}`);
    } else if (shown && !exactId) {
      deleteStatus = "blocked_session_id_mismatch";
      deleteBlockReason = "session_id_mismatch";
      blocked += 1;
      output.push(`session_preserved role=${target.role} ref=${target.ref} id=${id || "<missing>"} title=${title} reason=${deleteBlockReason}`);
    } else if (exactId) {
      if (!options.apply) deleteStatus = "skipped_no_apply";
      else if (!parentSessionId) {
        deleteStatus = "blocked_missing_parent_session_id";
        deleteBlockReason = "missing_parent_session_id";
        blocked += 1;
        output.push(`session_preserved role=${target.role} ref=${target.ref} id=${id} title=${title} reason=${deleteBlockReason} expected_owner=${options.ownerSessionId}`);
      } else if (parentSessionId !== options.ownerSessionId) {
        deleteStatus = "blocked_parent_session_id_mismatch";
        deleteBlockReason = "parent_session_id_mismatch";
        blocked += 1;
        output.push(`session_preserved role=${target.role} ref=${target.ref} id=${id} title=${title} reason=${deleteBlockReason} expected_owner=${options.ownerSessionId} actual_parent=${parentSessionId}`);
      } else if (!deleteEligible) {
        deleteStatus = "skipped_non_disposable_session";
        deleteBlockReason = "non_disposable_session";
        output.push(`session_preserved role=${target.role} ref=${target.ref} id=${id} title=${title} reason=non_disposable_session`);
      } else {
        const payload = deleteSession({ host: "thurbox", sessionId: id, profile: "" });
        deleteProvider = deleteProviderRecord(payload);
        deleteMode = payload.delete_mode;
        recoverable = payload.recoverable;
        if (payload.status === "deleted") {
          deleteStatus = "deleted";
          deleted = true;
        } else {
          deleteStatus = "delete_failed";
          deleteError = payload.error;
          failed += 1;
        }
      }
    }
    sessions.push({
      role: target.role,
      ref: target.ref,
      found: Boolean(shown),
      session_host: "thurbox",
      session_id: id || null,
      session_title: title || null,
      path: stringField(shown, "cwd") || stringField(shown, "repo_path") || stringField(shown, "path") || null,
      parent_session_id: parentSessionId || null,
      delete_eligible: deleteEligible,
      delete_applied: options.apply,
      delete_mode: deleteMode,
      recoverable,
      deleted,
      delete_status: deleteStatus,
      delete_block_reason: deleteBlockReason,
      delete_error: deleteError,
      delete_provider: deleteProvider,
      session_get: shown
    });
    output.push(`session role=${target.role} ref=${target.ref} found=${shown ? 1 : 0}${id ? ` id=${id}` : ""} delete_status=${deleteStatus}`);
  }
  return {
    mode: options.apply ? "archive_and_remove" : "archive_only",
    sessionHost: "thurbox",
    ownerSessionRef: options.ownerSessionId,
    ownerSessionId: options.ownerSessionId,
    ownerSessionGroup: null,
    profileName: null,
    stateDatabasePath: null,
    sessions,
    groupCleanup: [],
    blocked,
    failed,
    output
  };
}

function cleanupAgentDeck(options) {
  if (!resolveCommand("agent-deck")) fail("agent-deck not found in PATH");
  const ad = args => run("agent-deck", agentDeckArgs(options.profile, args));
  const adJson = args => commandJson("agent-deck", agentDeckArgs(options.profile, args));
  const current = adJson(["session", "current", "--json"]);
  const ownerRef = options.ownerSessionId || stringField(current, "id");
  if (!ownerRef) fail("failed to resolve current agent-deck session id; pass --owner-session-id");
  const profileName = options.profile || stringField(current, "profile") || "default";
  const dataRoot = agentDeckDataRoot(profileName);
  const databasePath = path.join(dataRoot, "profiles", profileName, "state.db");
  if (!fs.existsSync(databasePath)) debug(`provider_id_source=db result=state_db_missing profile=${profileName}`);
  const owner = adJson(["session", "show", ownerRef, "--json"]);
  const ownerId = stringField(owner, "id");
  const ownerGroup = stringField(owner, "group");
  const candidateGroups = new Set();
  const sessions = [];
  const output = [];
  let blocked = 0;
  let failed = 0;
  for (const target of options.targets) {
    const shown = adJson(["session", "show", target.ref, "--json"]);
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
    const deleteEligible = options.isDisposable(target.role, title, options.taskId);
    let deleted = false;
    let deleteStatus;
    let deleteBlockReason = "";
    let deleteError = null;
    let deleteProvider = null;
    if (!id) {
      deleteStatus = "not_found";
      sessions.push({
        role: target.role, ref: target.ref, found: false, tool: tool || null, provider_resume_ids: ids,
        has_provider_resume_id: Object.keys(ids).some(key => key.endsWith("_session_id")), provider_guard_expected_key: expected || null,
        provider_guard_required: guardRequired, provider_guard_passed: guardPassed, delete_eligible: deleteEligible,
        provider_resume_source: providerSource, raw_session_show: shown ? JSON.stringify(shown) : null,
        delete_applied: options.apply, deleted: false, delete_status: deleteStatus, delete_block_reason: null
      });
      output.push(`session role=${target.role} ref=${target.ref} found=0 delete_status=${deleteStatus}`);
      continue;
    }
    if (!options.apply) deleteStatus = "skipped_no_apply";
    else if (!deleteEligible) {
      deleteStatus = "skipped_non_disposable_session";
      deleteBlockReason = "non_disposable_session";
      output.push(`session_preserved role=${target.role} ref=${target.ref} id=${id} title=${title} reason=${deleteBlockReason}`);
    } else if (!guardPassed) {
      deleteStatus = "blocked_missing_provider_session_id";
      deleteBlockReason = "missing_provider_session_id";
      blocked += 1;
      output.push(`manual_close_required role=${target.role} ref=${target.ref} id=${id} tool=${tool} expected_key=${expected} reason=${deleteBlockReason}`);
      output.push(`manual_close_suggestion command='agent-deck remove ${id}'`);
    } else {
      const payload = deleteSession({ host: "agent-deck", sessionId: id, profile: options.profile });
      deleteProvider = deleteProviderRecord(payload);
      if (payload.status === "deleted") {
        deleteStatus = "deleted";
        deleted = true;
        const sessionGroup = stringField(shown, "group");
        if (ownerGroup && sessionGroup.startsWith(`${ownerGroup}/`)) {
          const root = `${ownerGroup}/${sessionGroup.slice(ownerGroup.length + 1).split("/")[0]}`;
          let group = sessionGroup;
          while (group === root || group.startsWith(`${root}/`)) {
            candidateGroups.add(group);
            if (group === root) break;
            group = group.slice(0, group.lastIndexOf("/"));
          }
        }
      } else {
        deleteStatus = "delete_failed";
        deleteError = payload.error;
        failed += 1;
      }
    }
    sessions.push({
      role: target.role, ref: target.ref, found: true, agent_deck_session_id: id, session_title: title, tool: tool || null, status: stringField(shown, "status") || null,
      group: stringField(shown, "group") || null, path: stringField(shown, "path") || null, provider_resume_ids: ids,
      has_provider_resume_id: Object.keys(ids).some(key => key.endsWith("_session_id")), provider_guard_expected_key: expected || null,
      provider_guard_required: guardRequired, provider_guard_passed: guardPassed, delete_eligible: deleteEligible,
      provider_resume_source: providerSource, session_show: shown, delete_applied: options.apply, deleted, delete_status: deleteStatus,
      delete_block_reason: deleteBlockReason || null, delete_error: deleteError, delete_provider: deleteProvider
    });
    output.push(`session role=${target.role} ref=${target.ref} found=1 id=${id} delete_status=${deleteStatus}`);
  }

  const groupCleanup = [];
  if (options.apply && candidateGroups.size > 0) {
    for (const groupPath of [...candidateGroups].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
      const groups = adJson(["group", "list", "--json"]);
      const allGroups = flattenGroups(groups?.groups);
      if (!allGroups.some(group => stringField(group, "path") === groupPath)) {
        groupCleanup.push({ group: groupPath, delete_status: "already_absent", session_count: 0, descendant_group_count: 0, delete_error: null });
        output.push(`group_cleanup group=${groupPath} delete_status=already_absent`);
        continue;
      }
      const inventory = adJson(["list", "--json"]);
      if (!Array.isArray(inventory) || !groups) {
        groupCleanup.push({ group: groupPath, delete_status: "check_failed", session_count: 0, descendant_group_count: 0, delete_error: "failed to inspect group occupancy" });
        output.push(`group_cleanup group=${groupPath} delete_status=check_failed`);
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
        output.push(`group_cleanup group=${groupPath} delete_status=${status}${sessionCount > 0 ? ` session_count=${sessionCount}` : ` descendant_group_count=${descendants}`}`);
        continue;
      }
      const removed = ad(["group", "delete", groupPath]);
      const status = removed.status === 0 ? "deleted" : "delete_failed";
      groupCleanup.push({ group: groupPath, delete_status: status, session_count: sessionCount, descendant_group_count: descendants, delete_error: status === "deleted" ? null : (removed.stderr || removed.stdout).trim() || null });
      output.push(`group_cleanup group=${groupPath} delete_status=${status}`);
    }
  }
  return {
    mode: options.apply ? "archive_and_remove" : "archive_only",
    sessionHost: "agent-deck",
    ownerSessionRef: ownerRef,
    ownerSessionId: ownerId || null,
    ownerSessionGroup: ownerGroup || null,
    profileName,
    stateDatabasePath: fs.existsSync(databasePath) ? databasePath : null,
    sessions,
    groupCleanup,
    blocked,
    failed,
    output
  };
}

export function cleanupSessionTargets(options) {
  if (options.sessionHost === "agent-deck") return cleanupAgentDeck(options);
  if (options.sessionHost === "thurbox") return cleanupThurbox(options);
  return {
    mode: "preserve_unsupported_host",
    sessionHost: options.sessionHost,
    ownerSessionRef: options.ownerSessionId || null,
    ownerSessionId: null,
    ownerSessionGroup: null,
    profileName: null,
    stateDatabasePath: null,
    sessions: options.targets.map(target => ({
      role: target.role,
      ref: target.ref,
      found: null,
      delete_applied: false,
      deleted: false,
      delete_status: "preserved_unsupported_host",
      delete_block_reason: "unsupported_host"
    })),
    groupCleanup: [],
    blocked: 0,
    failed: 0,
    output: [`session_cleanup_preserved host=${options.sessionHost} reason=unsupported_host`]
  };
}
