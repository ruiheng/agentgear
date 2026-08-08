#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  agentDeckArgs, commandJson, execute, fail, isMain, nowIso, parseArgs, run, stringField, writeJsonAtomic
} from "./workflow-lib.mjs";

const usage = `Archive and optionally remove one planner cleanup scope.

Usage:
  archive-and-remove-planner-group-sessions.mjs [options]

Options:
  --planner-session-id <id>      Planner session id; required cleanup scope source
  --artifact-root <path>         Artifact root (default: .agent-artifacts)
  --profile <name>               Optional agent-deck profile
  --apply                        Remove sessions and delete empty inferred groups after archiving
  -h, --help                     Show help

The live planner session is the sole authority for cleanup scope. Archived
group hints are intentionally never used to select live sessions.`;

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

function timestampKey() {
  return nowIso().replace(/[-:]/g, "").replace(".000", "");
}

function under(pathValue, root) {
  return pathValue === root || pathValue.startsWith(`${root}/`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--planner-session-id", "--artifact-root", "--profile"],
    flags: ["--apply"],
    defaults: { plannerSessionId: "", artifactRoot: ".agent-artifacts", profile: "", apply: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.plannerSessionId) fail("pass --planner-session-id");
  const ad = args => run("agent-deck", agentDeckArgs(options.profile, args));
  const adJson = args => commandJson("agent-deck", agentDeckArgs(options.profile, args));
  const planner = adJson(["session", "show", options.plannerSessionId, "--json"]);
  const plannerLive = Boolean(stringField(planner, "id"));
  const cleanupGroup = plannerLive ? stringField(planner, "group") : "";
  const fallbackScope = plannerLive && cleanupGroup && stringField(planner, "parent_session_id") && stringField(planner, "title")
    ? `${cleanupGroup.replace(/[\\/]+$/, "")}/${stringField(planner, "title")}`
    : "";
  const scopeWarning = plannerLive
    ? (cleanupGroup ? "" : "live planner session has no group; planner lane cleanup scope unavailable")
    : "planner session not found; planner lane cleanup scope unavailable";

  const listed = adJson(["list", "--json"]);
  if (!Array.isArray(listed)) fail("failed to build agent-deck session inventory");
  const inventory = new Map();
  for (const listedSession of listed) {
    const id = stringField(listedSession, "id");
    if (!id) continue;
    const shown = adJson(["session", "show", id, "--json"]);
    if (!stringField(shown, "id")) fail(`failed to inspect listed agent-deck session: ${id}`);
    inventory.set(id, shown);
  }
  const queued = new Set();
  const queue = id => { if (id) queued.add(id); };
  if (plannerLive) {
    queue(stringField(planner, "id"));
    const pending = [stringField(planner, "id")];
    const seen = new Set(pending);
    while (pending.length > 0) {
      const parent = pending.shift();
      for (const [id, session] of inventory) {
        if (stringField(session, "parent_session_id") !== parent) continue;
        queue(id);
        if (!seen.has(id)) {
          seen.add(id);
          pending.push(id);
        }
      }
    }
    // The fallback worker subgroup is intentionally narrow. Do not use the
    // planner's whole group as a session-delete scope: it may hold siblings.
    if (fallbackScope) {
      for (const [id, session] of inventory) if (under(stringField(session, "group"), fallbackScope)) queue(id);
    }
  } else {
    queue(options.plannerSessionId);
  }
  const queuedSessions = [...queued].map(id => inventory.get(id)).filter(Boolean);
  const parentIds = new Map(queuedSessions.map(session => [stringField(session, "id"), stringField(session, "parent_session_id")]));
  const ordered = [];
  const remaining = new Set(parentIds.keys());
  while (remaining.size > 0) {
    let progressed = false;
    for (const id of [...remaining]) {
      const hasChild = [...remaining].some(other => other !== id && parentIds.get(other) === id);
      if (!hasChild) {
        ordered.push(id);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) {
      ordered.push(...remaining);
      remaining.clear();
    }
  }
  const entries = [];
  let deleteFailed = false;
  for (const id of ordered) {
    const shown = inventory.get(id);
    let deleteStatus = "skipped_no_apply";
    let deleted = false;
    let deleteError = "";
    if (options.apply) {
      const removed = ad(["remove", id]);
      if (removed.status === 0) {
        deleteStatus = "deleted";
        deleted = true;
      } else if (/not found/i.test(removed.stderr || removed.stdout)) {
        deleteStatus = "already_absent";
      } else {
        deleteStatus = "delete_failed";
        deleteError = (removed.stderr || removed.stdout).trim();
        deleteFailed = true;
      }
    }
    entries.push({ found: true, session_show: shown, delete_applied: options.apply, deleted, delete_status: deleteStatus, delete_error: deleteError || null });
  }
  if (!plannerLive && !inventory.has(options.plannerSessionId)) {
    entries.push({ found: false, session_id: options.plannerSessionId, delete_applied: false, deleted: false, delete_status: "not_found" });
  }
  const archiveDirectory = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "planner-groups", `session_${options.plannerSessionId.replace(/[\\s/]+/g, "_")}`);
  const archiveFile = path.join(archiveDirectory, `session-archive-${timestampKey()}.json`);
  writeJsonAtomic(archiveFile, {
    planner_group: cleanupGroup || null,
    planner_group_source: cleanupGroup ? "live_planner" : null,
    planner_session_id: options.plannerSessionId,
    archived_at: nowIso(),
    mode: options.apply ? "archive_and_remove" : "archive_only",
    sessions: entries
  });
  process.stdout.write(`planner_group_archive_ok file=${archiveFile} mode=${options.apply ? "apply" : "preview"}\n`);

  let groupStatus = "skipped_no_apply";
  let groupWarning = "";
  let remainingScope = [];
  let derivedDeleted = 0;
  if (options.apply) {
    if (deleteFailed) groupStatus = "blocked_session_delete_failed";
    else if (!cleanupGroup) groupStatus = "not_applicable";
    else {
      const currentList = adJson(["list", "--json"]);
      if (!Array.isArray(currentList)) {
        groupStatus = "blocked_inventory_failed";
        deleteFailed = true;
      } else {
        const initiallyScoped = new Set(ordered);
        remainingScope = currentList.filter(session => initiallyScoped.has(stringField(session, "id")) || (fallbackScope && under(stringField(session, "group"), fallbackScope)));
        if (remainingScope.length > 0) {
          groupStatus = "blocked_nonempty";
          deleteFailed = true;
        } else {
          const candidates = new Set();
          const addAncestors = groupPath => {
            if (!groupPath || !under(groupPath, cleanupGroup)) return;
            let current = groupPath;
            while (true) {
              candidates.add(current);
              if (current === cleanupGroup) break;
              current = current.slice(0, current.lastIndexOf("/"));
              if (!current) break;
            }
          };
          addAncestors(fallbackScope);
          for (const entry of entries) if (entry.found) addAncestors(stringField(entry.session_show, "group"));
          for (const groupPath of [...candidates].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
            const groupTree = adJson(["group", "list", "--json"]);
            if (!groupTree) {
              groupWarning = `failed to inspect group tree before inferred cleanup for group=${groupPath}`;
              break;
            }
            const allGroups = flattenGroups(groupTree.groups);
            const group = allGroups.find(item => stringField(item, "path") === groupPath);
            if (!group) continue;
            const sessions = adJson(["list", "--json"]);
            if (!Array.isArray(sessions)) {
              groupWarning = `failed to inspect group tree before inferred cleanup for group=${groupPath}`;
              break;
            }
            const occupied = sessions.some(session => under(stringField(session, "group"), groupPath));
            const descendants = allGroups.some(item => {
              const candidate = stringField(item, "path");
              return candidate !== groupPath && candidate.startsWith(`${groupPath}/`);
            });
            if (occupied || descendants) continue;
            const deleted = ad(["group", "delete", groupPath]);
            if (deleted.status !== 0) {
              groupWarning = `group=${groupPath} error=${(deleted.stderr || deleted.stdout).trim()}`;
              break;
            }
            derivedDeleted += 1;
          }
          const finalGroups = adJson(["group", "list", "--json"]);
          if (!finalGroups) {
            groupStatus = "best_effort_group_inspection_failed";
            groupWarning ||= `failed to inspect group tree after cleanup for group=${cleanupGroup}`;
          } else if (flattenGroups(finalGroups.groups).some(group => stringField(group, "path") === cleanupGroup)) {
            groupStatus = derivedDeleted > 0 ? "deleted_derived_groups" : "best_effort_group_remaining";
            groupWarning ||= `group=${cleanupGroup} remained after best-effort cleanup`;
          } else {
            groupStatus = derivedDeleted > 0 ? "deleted_derived_groups" : "not_applicable";
          }
        }
      }
    }
  }
  process.stdout.write(`planner_group_cleanup planner_group=${cleanupGroup} planner_session_id=${options.plannerSessionId} group_delete_status=${groupStatus}\n`);
  for (const session of remainingScope) process.stdout.write(`planner_group_remaining session_id=${stringField(session, "id")} title=${stringField(session, "title") || "unknown"} group=${stringField(session, "group")} parent_session_id=${stringField(session, "parent_session_id")}\n`);
  if (scopeWarning) process.stdout.write(`planner_group_cleanup_warning planner_group=${cleanupGroup} planner_session_id=${options.plannerSessionId} warning=${scopeWarning}\n`);
  if (groupWarning) process.stdout.write(`planner_group_group_delete_warning planner_group=${cleanupGroup} warning=${groupWarning}\n`);
  if (options.apply && deleteFailed) process.exitCode = 3;
}

if (isMain(import.meta.url)) execute(() => main());
