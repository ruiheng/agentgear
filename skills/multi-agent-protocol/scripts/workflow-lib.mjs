import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function invokeNodeScript(scriptPath, args = [], options = {}) {
  return run(process.execPath, [scriptPath, ...args], options);
}

export function isMain(metaUrl) {
  const invoked = process.argv[1] && path.resolve(process.argv[1]);
  return invoked === path.resolve(fileURLToPath(metaUrl));
}
