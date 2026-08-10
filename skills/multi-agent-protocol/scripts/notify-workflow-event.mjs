#!/usr/bin/env node
import process from "node:process";
import { execute, isMain, parseArgs, resolveCommand, run } from "./workflow-lib.mjs";

export const usage = `Best-effort desktop notifications for Agentgear multi-agent workflow events.

Usage:
  notify-workflow-event.mjs [options]

Options:
  --event <name>             Required event name
  --task-id <id>             Optional task id
  --title <text>             Required notification title
  --message <text>           Required notification message
  --severity <level>         info|warn|error (default: info)
  --artifact-root <path>     Accepted for compatibility; ignored
  --dedupe-seconds <n>       Accepted for compatibility; ignored
  -h, --help                 Show help

Env:
  ADWF_NOTIFY                auto|off|force (default: auto)
  ADWF_NOTIFY_MIN_SEVERITY   info|warn|error (default: info)

This command never fails its caller workflow.`;

const ranks = { info: 0, warn: 1, error: 2 };

export function notify({ event, title, message, severity = "info" }) {
  if (!event || !title || !message) return;
  let mode = process.env.ADWF_NOTIFY || "auto";
  if (!["auto", "off", "force"].includes(mode)) mode = "auto";
  const normalizedSeverity = ranks[severity] === undefined ? "info" : severity;
  const minSeverity = ranks[process.env.ADWF_NOTIFY_MIN_SEVERITY] === undefined
    ? "info"
    : process.env.ADWF_NOTIFY_MIN_SEVERITY;
  if (mode === "off" || ranks[normalizedSeverity] < ranks[minSeverity]) return;

  const urgency = normalizedSeverity === "error" ? "critical" : "normal";
  if (process.platform === "linux") {
    const command = resolveCommand("notify-send") ? "notify-send" : resolveCommand("dunstify") ? "dunstify" : null;
    if (command) run(command, ["-a", "multi-agent-protocol", "-u", urgency, title, message]);
  } else if (process.platform === "darwin") {
    const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    run("osascript", ["-e", `display notification "${escapedMessage}" with title "${escapedTitle}"`]);
  }
}

export function notifyWorkflowEvent(event, severity, title, message, taskId = "", artifactRoot = ".agent-artifacts") {
  void taskId;
  void artifactRoot;
  try {
    notify({ event, severity, title, message });
  } catch {
    // Notifications are explicitly best effort.
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--event", "--task-id", "--title", "--message", "--severity", "--artifact-root", "--dedupe-seconds"],
    defaults: { severity: "info", artifactRoot: ".agent-artifacts", dedupeSeconds: "" },
    allowUnknown: true
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  notifyWorkflowEvent(options.event, options.severity, options.title, options.message, options.taskId, options.artifactRoot);
}

if (isMain(import.meta.url)) execute(() => main());
