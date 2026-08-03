#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import {
  commandJson, execute, fail, isMain, parseArgs, requireCommand, run, sleep, stringField
} from "./workflow-lib.mjs";
import { notifyWorkflowEvent } from "./notify-workflow-event.mjs";

const usage = `Usage:
  adwf-send-and-wake.mjs [options]

Required:
  --from-session-id <id>         Sender session id
  --subject <text>               Waypost Message subject
  --body-file <path|->           Body source, or "-" for stdin

Target selection:
  --to-session-id <id>           Existing target session id
  --to-session-ref <ref>         Existing target session ref/title

Optional target creation:
  --ensure-target-title <title>  Create target session with this title if missing
  --ensure-target-cmd <cmd>      Full command for target session launch
  --parent-session-id <id>       Parent session id for target session creation
  --workdir <path>               Workdir for agent-deck launch (default: cwd)

Optional:
  --content-type <type>          Waypost Message content type (default: text/markdown)
  --schema-version <value>       Waypost Message schema version (default: 1)
  --listener-message <text>      Bootstrap-only session-start instruction
  --wake-message <text>          Ignored; active-session wake instruction is fixed
  --wake-delay-seconds <n>       Delay before active-session wake send (default: 10)
  --json                         Emit JSON summary
  -h, --help                     Show help`;

function blocker(event, message) {
  notifyWorkflowEvent(event, "error", "Workflow dispatch blocked", message);
  fail(message, 1, "error");
}

function adJson(args) {
  return commandJson("agent-deck", args);
}

function session(sessionRef) {
  const shown = adJson(["session", "show", sessionRef, "--json"]);
  return shown && shown.success !== false ? shown : null;
}

function parseReceipt(output) {
  const result = {};
  for (const token of output.split(/\s+/)) {
    const match = token.match(/^(message_id|delivery_id|blob_id)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function replacePlaceholders(body, replacements) {
  return Object.entries(replacements).reduce(
    (result, [placeholder, value]) => result.split(placeholder).join(value),
    body
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--from-session-id", "--to-session-id", "--to-session-ref", "--ensure-target-title", "--ensure-target-cmd", "--parent-session-id", "--workdir", "--subject", "--body-file", "--content-type", "--schema-version", "--listener-message", "--wake-message", "--wake-delay-seconds"],
    flags: ["--json"],
    defaults: {
      fromSessionId: "", toSessionId: "", toSessionRef: "", ensureTargetTitle: "", ensureTargetCmd: "", parentSessionId: "",
      workdir: process.cwd(), subject: "", bodyFile: "", contentType: "text/markdown", schemaVersion: "1", listenerMessage: "", wakeMessage: "", wakeDelaySeconds: "10", json: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["fromSessionId", "--from-session-id"], ["subject", "--subject"], ["bodyFile", "--body-file"]]) {
    if (!options[key]) fail(`${label} is required`, 1, "error");
  }
  requireCommand("agent-deck");
  requireCommand("waypost");
  let createdTarget = false;

  if (!options.toSessionId && options.toSessionRef) options.toSessionId = stringField(session(options.toSessionRef), "id");
  if (!options.toSessionId) {
    if (!options.ensureTargetTitle) blocker("workflow_dispatch_target_missing", "target session missing: provide --to-session-id, --to-session-ref, or --ensure-target-title");
    if (!options.ensureTargetCmd) blocker("workflow_dispatch_target_cmd_missing", "--ensure-target-cmd is required when creating target session");
    if (!options.parentSessionId) blocker("workflow_dispatch_parent_missing", "--parent-session-id is required when creating target session");
    if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) blocker("workflow_dispatch_workdir_missing", `workdir does not exist: ${options.workdir}`);
    const parentGroup = stringField(session(options.parentSessionId), "group");
    const launch = ["launch", "--json", "--title", options.ensureTargetTitle, "--parent", options.parentSessionId, "--cmd", options.ensureTargetCmd];
    if (parentGroup) launch.push("--group", parentGroup);
    if (options.listenerMessage) launch.push("--message", options.listenerMessage);
    launch.push(options.workdir);
    const created = adJson(launch);
    options.toSessionId = stringField(created, "id");
    if (!options.toSessionId) fail("failed to parse created target session id", 1, "error");
    if (!parentGroup) {
      const moved = run("agent-deck", ["group", "move", options.toSessionId, ""]);
      if (moved.status !== 0) fail(`agent-deck group move (${options.toSessionId}) failed: ${(moved.stderr || moved.stdout).trim()}`, 1, "error");
    }
    if (!options.toSessionRef) options.toSessionRef = options.ensureTargetTitle;
    createdTarget = true;
  }

  const target = session(options.toSessionId);
  if (!options.toSessionRef) options.toSessionRef = stringField(target, "title") || options.toSessionId;
  let body;
  if (options.bodyFile === "-") body = fs.readFileSync(0, "utf8");
  else {
    if (!fs.statSync(options.bodyFile, { throwIfNoEntry: false })?.isFile()) fail(`body file not found: ${options.bodyFile}`, 1, "error");
    body = fs.readFileSync(options.bodyFile, "utf8");
  }
  body = replacePlaceholders(body, {
    "{{FROM_SESSION_ID}}": options.fromSessionId,
    "{{TO_SESSION_ID}}": options.toSessionId,
    "{{TO_SESSION_REF}}": options.toSessionRef
  });

  const currentSessionId = stringField(adJson(["session", "current", "--json"]), "id");
  let startStatus = "skipped_same_session";
  let listenerStatus = "skipped_same_session";
  let wakeupStatus = "skipped_same_session";
  let nudgeAfterSend = false;
  if (currentSessionId !== options.toSessionId) {
    if (createdTarget) {
      startStatus = "started";
      listenerStatus = options.listenerMessage ? "sent" : "not_sent";
      nudgeAfterSend = true;
    } else {
      const status = stringField(target, "status");
      if (["running", "waiting", "idle"].includes(status)) {
        startStatus = `already_${status}`;
        listenerStatus = "not_needed_existing_session";
        nudgeAfterSend = true;
      } else {
        const start = ["session", "start", "--json"];
        if (options.listenerMessage) start.push("-m", options.listenerMessage);
        start.push(options.toSessionId);
        const started = run("agent-deck", start);
        if (started.status !== 0) fail(`agent-deck session start (${options.toSessionId}) failed: ${(started.stderr || started.stdout).trim()}`, 1, "error");
        startStatus = "started";
        listenerStatus = options.listenerMessage ? "sent" : "not_sent";
        nudgeAfterSend = true;
      }
    }
  }

  const sent = run("waypost", ["send", "--to", `agent-deck/${options.toSessionId}`, "--from", `agent-deck/${options.fromSessionId}`, "--subject", options.subject, "--content-type", options.contentType, "--schema-version", options.schemaVersion, "--body-file", "-"], { input: body });
  if (sent.status !== 0) blocker("workflow_dispatch_send_failed", `waypost send failed: ${(sent.stderr || sent.stdout).trim() || `exit code ${sent.status}`}`);
  const receipt = parseReceipt(sent.stdout + sent.stderr);
  if (nudgeAfterSend) {
    const delay = Number(options.wakeDelaySeconds);
    if (Number.isFinite(delay) && delay > 0) await sleep(delay * 1000);
    const wake = run("agent-deck", ["session", "send", "--no-wait", options.toSessionId, "NOTICE: There might be new message in waypost."]);
    if (wake.status !== 0) fail(`agent-deck session send (${options.toSessionId}) failed: ${(wake.stderr || wake.stdout).trim()}`, 1, "error");
    wakeupStatus = "sent";
  }
  const summary = {
    from_session_id: options.fromSessionId,
    to_session_id: options.toSessionId,
    to_session_ref: options.toSessionRef,
    created_target: createdTarget,
    subject: options.subject,
    message_id: receipt.message_id || null,
    delivery_id: receipt.delivery_id || null,
    blob_id: receipt.blob_id || null,
    start_status: startStatus,
    listener_status: listenerStatus,
    wakeup_status: wakeupStatus,
    wake_delay_seconds: options.wakeDelaySeconds
  };
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(`dispatch_ok to_session_id=${options.toSessionId} to_session_ref=${options.toSessionRef} created_target=${createdTarget ? 1 : 0} message_id=${receipt.message_id || "none"} delivery_id=${receipt.delivery_id || "none"} start_status=${startStatus} listener_status=${listenerStatus} wakeup_status=${wakeupStatus} wake_delay_seconds=${options.wakeDelaySeconds}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
