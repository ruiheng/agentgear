#!/usr/bin/env node
import process from "node:process";
import {
  agentDeckArgs, commandJson, execute, fail, isMain, parseArgs, requireCommand, run, stringField
} from "./workflow-lib.mjs";

const usage = `Ensure a planner session exists as a child of the current supervisor session.

Usage:
  ensure-supervised-planner-session.mjs [options]

Options:
  --planner-session-ref <ref>     Required planner session title/ref
  --planner-cmd <command>         Required planner command
  --planner-workspace <path>      Required planner workspace path
  --supervisor-session-id <id>    Optional supervisor session id/ref (default: current session)
  --profile <name>                Optional agent-deck profile
  -h, --help                      Show help`;

function agentDeckJson(profile, args) {
  return commandJson("agent-deck", agentDeckArgs(profile, args));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--planner-session-ref", "--planner-cmd", "--planner-workspace", "--supervisor-session-id", "--profile"],
    defaults: { supervisorSessionId: "", profile: "" }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["plannerSessionRef", "--planner-session-ref"], ["plannerCmd", "--planner-cmd"], ["plannerWorkspace", "--planner-workspace"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  requireCommand("agent-deck");
  const supervisor = options.supervisorSessionId
    ? agentDeckJson(options.profile, ["session", "show", options.supervisorSessionId, "--json"])
    : agentDeckJson(options.profile, ["session", "current", "--json"]);
  if (!supervisor) fail("failed to resolve supervisor session; pass --supervisor-session-id");
  const supervisorId = stringField(supervisor, "id");
  if (!supervisorId) fail("supervisor session id is missing");
  const supervisorGroup = stringField(supervisor, "group");

  const existing = agentDeckJson(options.profile, ["session", "show", options.plannerSessionRef, "--json"]);
  if (existing && stringField(existing, "id")) {
    const id = stringField(existing, "id");
    let group = stringField(existing, "group");
    let status = "matched";
    if (stringField(existing, "path") !== options.plannerWorkspace) fail(`planner session path mismatch: ref='${options.plannerSessionRef}' existing='${stringField(existing, "path")}' expected='${options.plannerWorkspace}'`);
    if (stringField(existing, "parent_session_id") !== supervisorId) fail(`planner session '${options.plannerSessionRef}' is not a child of supervisor '${supervisorId}'`);
    if (group !== supervisorGroup) {
      run("agent-deck", agentDeckArgs(options.profile, ["group", "move", id, supervisorGroup]));
      group = supervisorGroup;
      status += "_moved";
    }
    if (!new Set(["running", "waiting", "idle"]).has(stringField(existing, "status"))) {
      const started = run("agent-deck", agentDeckArgs(options.profile, ["session", "start", id]));
      if (started.status !== 0) fail(`failed to start planner session '${options.plannerSessionRef}'`);
      status += "_started";
    }
    process.stdout.write(`planner_session status=${status} session_id=${id} session_ref=${options.plannerSessionRef} supervisor_session_id=${supervisorId} session_group=${group}\n`);
    return;
  }

  const launchArgs = ["launch", options.plannerWorkspace, "-t", options.plannerSessionRef, "--parent", supervisorId, "-c", options.plannerCmd, "--no-wait", "--json"];
  if (supervisorGroup) launchArgs.push("-g", supervisorGroup);
  const launched = agentDeckJson(options.profile, launchArgs);
  const id = stringField(launched, "id");
  if (!id) fail(`failed to create planner child session '${options.plannerSessionRef}' under supervisor '${supervisorId}'`);
  if (!supervisorGroup) run("agent-deck", agentDeckArgs(options.profile, ["group", "move", id, ""]));
  process.stdout.write(`planner_session status=created session_id=${id} session_ref=${options.plannerSessionRef} supervisor_session_id=${supervisorId} session_group=${supervisorGroup}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
