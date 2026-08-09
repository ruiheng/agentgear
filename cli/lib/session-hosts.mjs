import childProcess from "node:child_process";

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

function providerCommand(options) {
  if (options.host === "agent-deck") {
    return {
      command: "agent-deck",
      args: [...(options.profile ? ["-p", options.profile] : []), "remove", options.sessionId],
      deleteMode: "remove",
      recoverable: false
    };
  }
  if (options.host === "thurbox") {
    if (options.profile) fail("--profile is only valid with --host agent-deck");
    return {
      command: "thurbox-cli",
      args: ["session", "delete", options.sessionId, "--json"],
      deleteMode: "soft-delete",
      recoverable: true
    };
  }
  fail("Unsupported session host: " + options.host + ". Use agent-deck or thurbox.");
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

export function deleteSession(options, { spawnSync = childProcess.spawnSync } = {}) {
  if (!options.host) fail("--host is required");
  if (!options.sessionId) fail("--session-id is required");
  const provider = providerCommand(options);
  const result = spawnSync(provider.command, provider.args, {
    encoding: "utf8",
    windowsHide: true
  });
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
