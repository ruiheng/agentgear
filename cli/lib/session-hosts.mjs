import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionDeletionSpec } from "../../providers/session-hosts.mjs";
import process from "node:process";

const usage = `Usage: agentgear session delete [options]

Options:
  --host <agent-deck|thurbox>  Required session host
  --session-id <id>            Required exact session id
  --profile <name>             Agent Deck profile (default: none)
  --json                       JSON output (default: false)
  -h, --help                   Show help

Agent Deck removal is not recoverable. Thurbox deletion is a recoverable
soft-delete, and Agentgear never passes thurbox-cli session delete --force.
Callers must validate ownership before invoking this exact-id interface.`;

function fail(message) {
  throw new Error(message);
}

function parseDeleteOptions(argumentsList) {
  const options = { host: "", sessionId: "", profile: "", json: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (index >= argumentsList.length) fail("Missing value for " + argument);
      return argumentsList[index];
    };
    switch (argument) {
      case "--host":
        options.host = next();
        break;
      case "--session-id":
        options.sessionId = next();
        break;
      case "--profile":
        options.profile = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail("Unknown session delete option: " + argument);
    }
  }
  return options;
}

function providerError(result) {
  const stderr = result.stderr || "";
  const stdout = result.stdout || "";
  const message = result.error?.message || stderr.trim() || stdout.trim() || `provider command exited with status ${result.status ?? 1}`;
  return {
    message,
    exit_code: result.status ?? 1,
    ...(result.error?.code ? { code: result.error.code } : {})
  };
}

function resolveWindowsCommand(command, env = process.env) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return command;
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command.endsWith(extension) ? command : `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function quoteWindowsArgument(value) {
  if (/^[^\s"&|<>^()]+$/.test(value)) return value;
  return `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`;
}

function rejectedWindowsCommandValue(values) {
  return values.find(value => String(value).includes("%"));
}

function invokeProvider(command, args, { spawnSync, env = process.env, platform = process.platform }) {
  const resolved = platform === "win32" ? resolveWindowsCommand(command, env) : command;
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const rejected = rejectedWindowsCommandValue([resolved, ...args]);
    if (rejected !== undefined) {
      const error = new Error("refusing to pass a percent-containing provider value through cmd.exe");
      error.code = "EINVAL";
      return { error, status: null, stdout: "", stderr: "" };
    }
    const line = [resolved, ...args].map(quoteWindowsArgument).join(" ");
    return spawnSync(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      encoding: "utf8",
      windowsHide: true,
      env
    });
  }
  return spawnSync(resolved, args, { encoding: "utf8", windowsHide: true, env });
}

export function deleteSession(options, { spawnSync = childProcess.spawnSync, env = process.env, platform = process.platform } = {}) {
  if (!options.host) fail("--host is required");
  if (!options.sessionId) fail("--session-id is required");
  const provider = sessionDeletionSpec(options);
  const result = invokeProvider(provider.command, provider.args, { spawnSync, env, platform });
  const payload = {
    schema_version: 1,
    operation: "session_delete",
    host: options.host,
    session_id: options.sessionId,
    delete_mode: provider.deleteMode,
    recoverable: provider.recoverable,
    status: result.error || result.status !== 0 ? "failed" : "deleted",
    provider_command: provider.command,
    provider_stdout: result.stdout || "",
    provider_stderr: result.stderr || "",
    error: null
  };
  if (payload.status === "failed") payload.error = providerError(result);
  return payload;
}

export function runSessionCommand(argumentsList, { print = message => process.stdout.write(`${message}\n`) } = {}) {
  const [action, ...actionArguments] = argumentsList;
  if (!action || action === "--help" || action === "-h") {
    print(usage);
    return;
  }
  if (action !== "delete") fail("Unknown session command: " + action);
  const options = parseDeleteOptions(actionArguments);
  if (options.help) {
    print(usage);
    return;
  }
  const result = deleteSession(options);
  if (options.json) print(JSON.stringify(result, null, 2));
  else {
    print(`session_delete status=${result.status} host=${result.host} session_id=${result.session_id} mode=${result.delete_mode} recoverable=${result.recoverable}`);
    if (result.error) print(`session_delete_error exit_code=${result.error.exit_code} message=${JSON.stringify(result.error.message)}`);
  }
  if (result.status !== "deleted") process.exitCode = 3;
}

export { usage as sessionUsage };
