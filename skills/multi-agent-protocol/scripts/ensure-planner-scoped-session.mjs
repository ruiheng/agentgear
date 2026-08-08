#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  agentDeckArgs, commandJson, execute, fail, isMain, parseArgs, readJson, requireCommand, run, stringField
} from "./workflow-lib.mjs";

const usage = `Ensure a planner-scoped workflow session exists as a child of the recorded planner session.

Usage:
  ensure-planner-scoped-session.mjs [options]

Options:
  --session-ref <ref>            Required session title/ref
  --session-cmd <command>        Required session command
  --session-workspace <path>     Optional session workspace path (default: current directory)
  --artifact-root <path>         Artifact root (default: .agent-artifacts)
  --profile <name>               Optional agent-deck profile
  -h, --help                     Show help`;

function agentDeckJson(profile, args) {
  return commandJson("agent-deck", agentDeckArgs(profile, args));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--session-ref", "--session-cmd", "--session-workspace", "--artifact-root", "--profile"],
    defaults: { sessionWorkspace: process.cwd(), artifactRoot: ".agent-artifacts", profile: "" }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.sessionRef) fail("--session-ref is required");
  if (!options.sessionCmd) fail("--session-cmd is required");
  requireCommand("agent-deck");
  const recordFile = path.join(options.artifactRoot.replace(/[\\/]+$/, ""), "planner-workspace.json");
  if (!fs.existsSync(recordFile)) fail(`planner workspace record missing: ${recordFile}`);
  const plannerRef = stringField(readJson(recordFile), "planner_session_id");
  if (!plannerRef) fail(`planner workspace record missing planner_session_id: ${recordFile}`);
  const planner = agentDeckJson(options.profile, ["session", "show", plannerRef, "--json"]);
  const plannerId = stringField(planner, "id");
  if (!plannerId) fail(`planner session recorded in workspace no longer exists: ${plannerRef}`);
  const plannerGroup = stringField(planner, "group");

  const existing = agentDeckJson(options.profile, ["session", "show", options.sessionRef, "--json"]);
  if (existing && stringField(existing, "id")) {
    const id = stringField(existing, "id");
    let group = stringField(existing, "group");
    let status = "matched";
    if (stringField(existing, "path") !== options.sessionWorkspace) fail(`session path mismatch: ref='${options.sessionRef}' existing='${stringField(existing, "path")}' expected='${options.sessionWorkspace}'`);
    if (stringField(existing, "parent_session_id") !== plannerId) fail(`existing session '${options.sessionRef}' is not a child of planner session '${plannerId}'`);
    if (group !== plannerGroup) {
      const moved = run("agent-deck", agentDeckArgs(options.profile, ["group", "move", id, plannerGroup]));
      if (moved.status !== 0) fail(`failed to move session '${options.sessionRef}' to planner group`);
      group = plannerGroup;
      status += "_moved";
    }
    if (!new Set(["running", "waiting", "idle"]).has(stringField(existing, "status"))) {
      const started = run("agent-deck", agentDeckArgs(options.profile, ["session", "start", id]));
      if (started.status !== 0) fail(`failed to start session '${options.sessionRef}'`);
      status += "_started";
    }
    process.stdout.write(`planner_scoped_session status=${status} session_id=${id} session_ref=${options.sessionRef} planner_session_id=${plannerId} session_group=${group}\n`);
    return;
  }
  const launchArgs = ["launch", options.sessionWorkspace, "-t", options.sessionRef, "--parent", plannerId, "-c", options.sessionCmd, "--no-wait", "--json"];
  if (plannerGroup) launchArgs.push("-g", plannerGroup);
  const launched = agentDeckJson(options.profile, launchArgs);
  const id = stringField(launched, "id");
  if (!id) fail(`failed to create child session '${options.sessionRef}' under planner session '${plannerId}'`);
  if (!plannerGroup) run("agent-deck", agentDeckArgs(options.profile, ["group", "move", id, ""]));
  process.stdout.write(`planner_scoped_session status=created session_id=${id} session_ref=${options.sessionRef} planner_session_id=${plannerId} session_group=${plannerGroup}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
