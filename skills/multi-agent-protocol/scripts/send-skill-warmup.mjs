#!/usr/bin/env node
import process from "node:process";
import { classifyWaypostSend, execute, fail, isMain, parseArgs, runWaypostSendStreaming } from "./workflow-lib.mjs";
import { appendStickyTaskContextMarker } from "./compact-memory-shared.mjs";

export const usage = `Ask one collaborator session to load a task's key skills before its first task delivery.

Usage:
  send-skill-warmup.mjs --task-id <id> --from-address <address> --to-address <address> \\
    --skill <selector> [--skill <selector> ...] [--json]

Options:
  --task-id <id>            Task the warmup belongs to
  --from-address <address>  Sender Waypost address
  --to-address <address>    Recipient session's Waypost address
  --skill <selector>        Agentgear skill selector to load; repeatable
  --content-type <type>     Waypost content type (default: text/markdown)
  --schema-version <ver>    Waypost schema version (default: 1)
  --json                    Print the result as JSON
  -h, --help                Show help

The notice is an ordinary sticky Waypost message with no Action field and no
wake. The recipient's first task delivery wakes it, and Waypost returns this
older notice first.`;

// Selectors are either an action address or a skill with an optional slice;
// the receiver passes them verbatim to \`agentgear skill get\`.
const SKILL_SELECTOR = /^(?:action:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}|[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)$/;
const PLAIN_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export function skillWarmupCommand(selectors) {
  return `agentgear skill get ${selectors.join(" ")}`;
}

export function skillWarmupSubject(taskId, selectors) {
  return `skill warmup: ${taskId}: ${skillWarmupCommand(selectors)}`;
}

export function skillWarmupBody(taskId, selectors) {
  return appendStickyTaskContextMarker([
    `Task ${taskId} is starting. Load its key skills before handling its deliveries:`,
    "",
    `    ${skillWarmupCommand(selectors)}`,
    "",
    "This is an ordinary message, not an Action: run that command, ack this notice, then keep receiving."
  ].join("\n"));
}

function plain(value, label) {
  if (typeof value !== "string" || !PLAIN_TEXT.test(value)) fail(`${label} is required and must be one line of plain text`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: ["--task-id", "--from-address", "--to-address", "--content-type", "--schema-version"],
    repeatableValues: ["--skill"],
    flags: ["--json"],
    defaults: { contentType: "text/markdown", schemaVersion: "1", json: false }
  });
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write(`${usage}\n`);
    return;
  }
  plain(options.taskId, "--task-id");
  plain(options.fromAddress, "--from-address");
  plain(options.toAddress, "--to-address");
  plain(options.contentType, "--content-type");
  plain(options.schemaVersion, "--schema-version");
  const selectors = [...new Set(options.skill || [])];
  if (selectors.length === 0) fail("at least one --skill is required");
  for (const selector of selectors) {
    if (!SKILL_SELECTOR.test(selector)) fail(`--skill ${JSON.stringify(selector)} is not an Agentgear skill selector`);
  }
  if (options.fromAddress === options.toAddress) fail("--to-address must differ from --from-address");

  const args = [
    "send", "--to", options.toAddress,
    "--from", options.fromAddress,
    "--subject", skillWarmupSubject(options.taskId, selectors),
    "--content-type", options.contentType,
    "--schema-version", options.schemaVersion,
    "--body-file", "-",
    "--ndjson"
  ];
  const input = skillWarmupBody(options.taskId, selectors);
  const raw = dependencies.runWaypost
    ? await dependencies.runWaypost("waypost", args, { input })
    : await runWaypostSendStreaming(args, { input });
  const sent = classifyWaypostSend(raw);
  if (sent.status === "interrupted") {
    fail("skill warmup send interrupted; delivery is unknown, inspect Waypost before retrying", 4, "SEND_INTERRUPTED");
  }
  if (sent.status === "receipt_unknown") {
    fail("skill warmup send result is unclear; inspect Waypost before retrying", 5, "SEND_RECEIPT_UNKNOWN");
  }
  if (sent.status !== "sent") fail(`skill warmup send failed: ${sent.detail || "unknown error"}`, 3, "SEND_FAILED");
  const deliveryId = sent.receipt.delivery_id;
  stdout.write(options.json
    ? `${JSON.stringify({ status: "sent", task_id: options.taskId, to_address: options.toAddress, skills: selectors, delivery_id: deliveryId })}\n`
    : `Skill warmup sent: ${options.taskId} -> ${options.toAddress} delivery_id=${deliveryId}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
