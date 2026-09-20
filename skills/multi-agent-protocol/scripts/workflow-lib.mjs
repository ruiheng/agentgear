import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionProbeOutcome, sessionProbeSpec } from "../../../providers/session-hosts.mjs";

export class WorkflowError extends Error {
  constructor(message, exitCode = 2, prefix = "ERROR") {
    super(message);
    this.exitCode = exitCode;
    this.prefix = prefix;
  }
}

export function fail(message, exitCode = 2, prefix = "ERROR") {
  throw new WorkflowError(message, exitCode, prefix);
}

export function printError(error) {
  if (error instanceof WorkflowError) {
    process.stderr.write(`${error.prefix}: ${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}

export async function execute(main) {
  try {
    await main();
  } catch (error) {
    printError(error);
  }
}

export function parseArgs(argv, { values = [], repeatableValues = [], flags = [], defaults = {}, allowUnknown = false } = {}) {
  const result = { ...defaults, _: [] };
  const valueSet = new Set(values);
  const repeatableValueSet = new Set(repeatableValues);
  const flagSet = new Set(flags);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (valueSet.has(argument) || repeatableValueSet.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (repeatableValueSet.has(argument)) {
        if (!Array.isArray(result[key])) result[key] = [];
        result[key].push(value);
      } else {
        result[key] = value;
      }
      index += 1;
      continue;
    }
    if (flagSet.has(argument)) {
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      result.help = true;
      continue;
    }
    if (allowUnknown) {
      result._.push(argument);
      continue;
    }
    fail(`unknown arg: ${argument}`);
  }
  return result;
}

function commandCandidates(command, env = process.env) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return [command];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (env.PATH || "").split(path.delimiter).flatMap(directory =>
    extensions.map(extension => path.join(directory, command.endsWith(extension) ? command : command + extension))
  );
}

export function resolveCommand(command, env = process.env) {
  for (const candidate of commandCandidates(command, env)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export function requireCommand(command) {
  const resolved = resolveCommand(command);
  if (!resolved) fail(`${command} is required`);
  return resolved;
}

function quoteWindowsArgument(value) {
  if (/^[^\s"&|<>^()]+$/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

function spawnCommand(command, args, options = {}) {
  const resolved = resolveCommand(command) || command;
  const useCmd = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved);
  if (useCmd) {
    const line = [resolved, ...args].map(quoteWindowsArgument).join(" ");
    return childProcess.spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options);
  }
  return childProcess.spawnSync(resolved, args, options);
}

function spawnCommandAsync(command, args, options = {}) {
  const resolved = resolveCommand(command) || command;
  const useCmd = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved);
  if (useCmd) {
    const line = [resolved, ...args].map(quoteWindowsArgument).join(" ");
    return childProcess.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options);
  }
  return childProcess.spawn(resolved, args, options);
}

export function run(command, args = [], { cwd, input, env, stdio = "pipe", timeoutMs = 0, killSignal = "SIGTERM" } = {}) {
  const result = spawnCommand(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: "utf8",
    stdio,
    windowsHide: true,
    ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal } : {})
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

export function runWaypostSendStreaming(args, { cwd, input, env, timeoutMs = 0, onReceipt } = {}) {
  return new Promise((resolve) => {
    const child = spawnCommandAsync("waypost", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let receiptPayload = null;
    const finish = (value, { keepTimer = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timer && !keepTimer) clearTimeout(timer);
      resolve(value);
    };
    let pendingOutput = "";
    const maybeComplete = () => {
      const lines = pendingOutput.split(/\r?\n/);
      pendingOutput = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload?.delivery_id && !receiptPayload) {
            receiptPayload = payload;
            // The NDJSON receipt line is emitted before the potentially slow
            // notify phase; surface it so callers can report durable progress.
            if (typeof onReceipt === "function") {
              try { onReceipt(payload); } catch {}
            }
          }
          if (receiptPayload?.delivery_id && payload?.notify_status) {
            finish({
              status: 0,
              stdout: `${JSON.stringify({ ...receiptPayload, ...payload })}\n`,
              stderr: "",
              error: null,
              signal: null,
              timedOut: false
            }, { keepTimer: true });
            return;
          }
        } catch {}
      }
    };
    child.stdout.on("data", chunk => { const text = chunk.toString(); stdout += text; pendingOutput += text; maybeComplete(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.stdin.on("error", error => {
      const result = { status: 1, stdout, stderr, error, signal: null, timedOut: false };
      finish(result);
    });
    child.on("error", error => {
      const result = { status: 1, stdout, stderr, error, signal: null, timedOut: false };
      finish(result);
    });
    child.on("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      if (!settled) finish({ status: status ?? 1, stdout, stderr, error: null, signal, timedOut: false });
    });
    if (timeoutMs > 0) timer = setTimeout(() => {
      child.kill("SIGTERM");
      const timedOut = { status: 1, stdout, stderr, error: null, signal: "SIGTERM", timedOut: true };
      finish(timedOut);
    }, timeoutMs);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function runChecked(command, args = [], options = {}, description = command) {
  const result = run(command, args, options);
  if (result.error) fail(`${description} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    fail(detail ? `${description} failed: ${detail}` : `${description} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

export function jsonFromText(source, label = "JSON") {
  try {
    return JSON.parse(source);
  } catch {
    fail(`failed to parse ${label}`);
  }
}

export function stringField(object, field) {
  const value = object?.[field];
  return typeof value === "string" ? value : "";
}

export function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`failed to read JSON: ${label}`);
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

export function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

export function absoluteExistingPath(value, label = "path") {
  const candidate = path.resolve(value);
  if (!fs.existsSync(candidate)) fail(`${label} does not exist: ${value}`);
  return fs.realpathSync(candidate);
}

export function currentScriptDirectory(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function commandJson(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function agentDeckArgs(profile, args) {
  return profile ? ["-p", profile, ...args] : args;
}

export const DEFAULT_SEND_TIMEOUT_MS = 0;

function optionalOutputString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function sendOutputFrom(output) {
  const payload = JSON.parse(output.trim().split(/\r?\n/, 1)[0]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("waypost send returned a non-object JSON payload");
  }
  const receipt = {};
  for (const key of ["delivery_id", "message_id", "blob_id"]) {
    const value = optionalOutputString(payload[key]);
    if (value) receipt[key] = value;
  }
  const notifyStatus = optionalOutputString(payload.notify_status);
  return {
    receipt,
    notification: {
      status: notifyStatus || "unknown",
      scheme: optionalOutputString(payload.notify_scheme),
      detail: optionalOutputString(payload.notify_detail),
      error: optionalOutputString(payload.notify_error)
        || (notifyStatus ? null : "waypost send --notify returned no notify_status")
    }
  };
}

export function receiptFrom(output) {
  try {
    return sendOutputFrom(output).receipt;
  } catch {
    const receipt = {};
    for (const token of output.split(/\s+/)) {
      const match = token.match(/^(delivery_id|message_id|blob_id)=(.*)$/);
      if (match) receipt[match[1]] = match[2];
    }
    return receipt;
  }
}

// classifyWaypostSend turns a raw waypost send --notify result into one of
// sent / failed / interrupted / receipt_unknown. A spawn timeout or signal can
// still follow a persisted delivery, so receipts are recovered from partial
// stdout before reporting the send as interrupted.
export function classifyWaypostSend(send) {
  if (send.timedOut || send.signal) {
    try {
      const parsed = sendOutputFrom(send.stdout || "");
      if (parsed.receipt.delivery_id) return { status: "sent", ...parsed };
    } catch {}
    const receipt = receiptFrom(send.stdout || "");
    if (receipt.delivery_id) {
      return {
        status: "sent",
        receipt,
        notification: { status: "unknown", scheme: null, detail: null, error: "Waypost receipt recovered after interruption" }
      };
    }
    return { status: "interrupted", signal: send.signal || "SIGTERM", timedOut: send.timedOut };
  }
  if (send.error) {
    return { status: "failed", detail: `waypost send --notify could not start: ${send.error.message}` };
  }
  if (send.status !== 0) {
    const stream = send.stderr.trim() ? "stderr" : "stdout";
    const detail = (send.stderr || send.stdout).trim() || `exit code ${send.status}`;
    return { status: "failed", detail: `waypost send --notify exited ${send.status} (${stream}): ${detail}` };
  }
  const raw = send.stdout + send.stderr;
  let parsed;
  try {
    parsed = sendOutputFrom(send.stdout);
  } catch {
    const receipt = receiptFrom(send.stdout);
    return receipt.delivery_id
      ? { status: "sent", receipt, notification: { status: "unknown", scheme: null, detail: null, error: "Waypost receipt used legacy text parsing" } }
      : { status: "receipt_unknown", raw };
  }
  return parsed.receipt.delivery_id ? { status: "sent", ...parsed } : { status: "receipt_unknown", raw };
}

export function sessionAddressId(address) {
  const separator = address.indexOf("/");
  if (separator <= 0 || separator === address.length - 1) return null;
  return { scheme: address.slice(0, separator), id: address.slice(separator + 1) };
}

// dispatchProbeDeps maps the shared workflow dependency bag onto the
// verifyDispatchTarget option names so each workflow does not rebuild it.
export function dispatchProbeDeps(dependencies, sessionHost) {
  return {
    sessionHost,
    stderr: dependencies.stderr || process.stderr,
    runCommand: dependencies.runSessionProbe,
    commandExists: dependencies.probeCommandExists
  };
}

// verifyDispatchTarget probes the host CLI embedded in a scheme/id address
// before a dispatch sends to it, so a dead hosted session fails the run before
// any state is created or Waypost delivery is persisted. Schemes without a
// probe are skipped because there is no read-only host check to run. It returns
// the verified target binding; send helpers take that value so a send cannot
// silently skip this check.
export function verifyDispatchTarget(role, address, sessionId, {
  sessionHost,
  stderr = process.stderr,
  runCommand = run,
  commandExists = resolveCommand
} = {}) {
  const target = sessionAddressId(address);
  if (!target) {
    fail(`${role} target address is not a scheme/id address: ${address}`, 6, "TARGET_SESSION_UNVERIFIED");
  }
  const spec = sessionProbeSpec({ host: target.scheme, sessionId: target.id });
  if (!spec) {
    stderr.write(`${role} target check skipped: no session probe for scheme '${target.scheme}'\n`);
    return Object.freeze({ role, address, sessionId, host: sessionHost || null });
  }
  if (sessionId !== target.id) {
    fail(`${role} session id '${sessionId}' does not match its ${target.scheme} address id '${target.id}'`, 6, "TARGET_SESSION_MISMATCH");
  }
  if (sessionHost && sessionHost !== target.scheme) {
    fail(`${role} session host '${sessionHost}' does not match its address scheme '${target.scheme}'`, 6, "TARGET_SESSION_MISMATCH");
  }
  if (!commandExists(spec.command)) {
    fail(`cannot verify ${role} session '${target.id}': ${spec.command} is not in PATH`, 6, "TARGET_SESSION_UNVERIFIED");
  }
  const outcome = sessionProbeOutcome(target.scheme, runCommand(spec.command, spec.args, { timeoutMs: spec.timeoutMs }));
  if (outcome.status === "not_found") {
    fail(`${role} session '${target.id}' does not exist on ${target.scheme}: ${outcome.detail || "session probe reported not found"}`, 6, "TARGET_SESSION_NOT_FOUND");
  }
  if (outcome.status !== "exists") {
    fail(`could not verify ${role} session '${target.id}' on ${target.scheme}: ${outcome.error || outcome.detail || "session probe inconclusive"}`, 6, "TARGET_SESSION_UNVERIFIED");
  }
  stderr.write(`verified ${role} session ${target.scheme}/${target.id}\n`);
  return Object.freeze({ role, address, sessionId: target.id, host: target.scheme });
}

export function workspaceLaneKey(workerWorkspace) {
  const hash = crypto.createHash("sha256").update(workerWorkspace).digest("hex").slice(0, 16);
  const base = (path.basename(workerWorkspace) || "lane").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lane";
  return `${base}-${hash}`;
}

export function plannerLaneRecordPath(plannerArtifactRoot, workerWorkspace) {
  return path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), "planner-workspaces", `${workspaceLaneKey(workerWorkspace)}.json`);
}

export function findPlannerLaneRecord(plannerArtifactRoot, workerWorkspace) {
  const keyed = plannerLaneRecordPath(plannerArtifactRoot, workerWorkspace);
  if (fs.existsSync(keyed)) return keyed;
  const legacy = path.join(plannerArtifactRoot.replace(/[\\/]+$/, ""), "planner-workspace.json");
  if (!fs.existsSync(legacy)) return null;
  try {
    return stringField(readJson(legacy), "worker_workspace") === workerWorkspace ? legacy : null;
  } catch {
    return null;
  }
}

export function invokeNodeScript(scriptPath, args = [], options = {}) {
  return run(process.execPath, [scriptPath, ...args], options);
}

export function isMain(metaUrl) {
  const invoked = process.argv[1] && path.resolve(process.argv[1]);
  return invoked === path.resolve(fileURLToPath(metaUrl));
}
