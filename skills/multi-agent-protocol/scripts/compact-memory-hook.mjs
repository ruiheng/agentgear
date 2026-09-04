#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hasStickyTaskContextMarker } from "./compact-memory-shared.mjs";

export const STICKY_MESSAGE_LIMIT = 8;
export const SKILL_GET_LIMIT = 32;
// Add newly observed, stable error messages here. Matching is case-insensitive.
export const RECOVERABLE_STOP_PATTERNS = Object.freeze([
  /exceeded retry limit,?\s*last status:\s*429\s+too many requests/iu
]);
export const RECOVERY_INITIAL_DELAY_SECONDS = 10;
export const RECOVERY_MAX_DELAY_SECONDS = 5 * 60;
export const RECOVERY_MAX_ATTEMPTS = 6;
const ERROR_DETAIL_LIMIT = 500;

function stateHome(env) {
  const home = env.HOME || os.homedir();
  return env.XDG_STATE_HOME || path.join(home, ".local", "state");
}

export function sessionMemoryDirectory(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Codex hook input is missing session_id");
  const key = crypto.createHash("sha256").update(sessionId).digest("hex");
  return path.join(stateHome(env), "agentgear", "compact-memory", key);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function blockingSleep(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.ceil(milliseconds));
}

function recoveryStateFile(root) {
  return path.join(root, "recovery-state.json");
}

function readRecoveryState(root) {
  const existing = readJson(recoveryStateFile(root));
  if (existing === undefined) return { schema_version: 1, consecutive_errors: 0, exhausted: false };
  if (!isPlainObject(existing) || existing.schema_version !== 1
    || !Number.isSafeInteger(existing.consecutive_errors) || existing.consecutive_errors < 0
    || (existing.exhausted !== undefined && typeof existing.exhausted !== "boolean")) {
    throw new Error(`Invalid recovery state schema: ${recoveryStateFile(root)}`);
  }
  return {
    schema_version: 1,
    consecutive_errors: existing.consecutive_errors,
    exhausted: existing.exhausted === true
  };
}

function writeRecoveryState(root, state) {
  writeJsonAtomic(recoveryStateFile(root), {
    schema_version: 1,
    consecutive_errors: state.consecutive_errors,
    exhausted: state.exhausted === true
  });
}

export function recoverableStopMatch(message, patterns = RECOVERABLE_STOP_PATTERNS) {
  if (typeof message !== "string") return null;
  for (const [index, pattern] of patterns.entries()) {
    if (!(pattern instanceof RegExp)) throw new TypeError(`Recoverable stop pattern ${index} must be a RegExp`);
    pattern.lastIndex = 0;
    if (pattern.test(message)) return index;
  }
  return null;
}

export function recoveryDelaySeconds(consecutiveErrors) {
  if (!Number.isSafeInteger(consecutiveErrors) || consecutiveErrors < 1) return 0;
  return Math.min(
    RECOVERY_MAX_DELAY_SECONDS,
    RECOVERY_INITIAL_DELAY_SECONDS * (2 ** (consecutiveErrors - 1))
  );
}

function recoveryMessage(delaySeconds) {
  return `Agentgear 检测到可恢复的上游错误，将在 ${delaySeconds} 秒后继续（发送 go on）；不会并行重试。`;
}

function recoveryExhaustedMessage() {
  return `Agentgear 已连续自动恢复 ${RECOVERY_MAX_ATTEMPTS} 次，停止继续重试；请稍后重新提交任务。`;
}

function handleStop(input, {
  env = process.env,
  sleep = blockingSleep,
  patterns = RECOVERABLE_STOP_PATTERNS
} = {}) {
  const root = sessionMemoryDirectory(input.session_id, env);
  const state = readRecoveryState(root);

  // Once this continuation chain has exhausted Agentgear's budget, abstain
  // from later decisions. Other Stop hooks retain control of continuation.
  if (input.stop_hook_active === true && state.exhausted === true) {
    return null;
  }

  // A non-continuation Stop starts a new recovery chain. This prevents a
  // later user turn from inheriting the previous turn's retry budget.
  if (input.stop_hook_active !== true && (state.consecutive_errors !== 0 || state.exhausted)) {
    state.consecutive_errors = 0;
    state.exhausted = false;
    writeRecoveryState(root, state);
  }

  const match = recoverableStopMatch(input.last_assistant_message, patterns);
  if (match === null) {
    if (input.stop_hook_active !== true
      && (state.consecutive_errors !== 0 || state.exhausted)) {
      writeRecoveryState(root, { consecutive_errors: 0, exhausted: false });
    }
    return null;
  }
  const consecutiveErrors = state.consecutive_errors + 1;
  if (input.stop_hook_active === true && consecutiveErrors > RECOVERY_MAX_ATTEMPTS) {
    writeRecoveryState(root, {
      consecutive_errors: state.consecutive_errors,
      exhausted: true
    });
    return { systemMessage: recoveryExhaustedMessage() };
  }
  const delaySeconds = recoveryDelaySeconds(consecutiveErrors);
  writeRecoveryState(root, { consecutive_errors: consecutiveErrors, exhausted: false });
  sleep(delaySeconds * 1000);
  return {
    decision: "block",
    reason: "go on",
    systemMessage: recoveryMessage(delaySeconds)
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read compact memory ${filePath}: ${error.message}`, { cause: error });
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsedJson(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function responseFailed(response) {
  if (!isPlainObject(response)) return false;
  if (response.isError === true || response.is_error === true) return true;
  for (const field of ["exit_code", "exitCode"]) {
    if (Number.isInteger(response[field]) && response[field] !== 0) return true;
  }
  return false;
}

function responseRoots(response) {
  if (responseFailed(response)) return [];
  const roots = [response];
  if (isPlainObject(response)) {
    for (const field of ["structuredContent", "structured_content", "output"]) {
      if (response[field] !== undefined) roots.push(response[field]);
    }
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (isPlainObject(item) && typeof item.text === "string") roots.push(item.text);
      }
    }
  }
  return roots.map(value => parsedJson(value) ?? value);
}

function stickyMessageCandidates(response) {
  const candidates = [];
  const visited = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (isPlainObject(value)
      && typeof value.body === "string"
      && typeof value.delivery_id === "string"
      && value.delivery_id !== "") {
      if (hasStickyTaskContextMarker(value.body)) candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      for (const item of Object.values(value)) visit(item);
    }
  };
  for (const root of responseRoots(response)) visit(root);
  return candidates;
}

function memoryFile(root) {
  return path.join(root, "memory.json");
}

function readMemory(root) {
  const filePath = memoryFile(root);
  const existing = readJson(filePath);
  if (existing === undefined) {
    return { schema_version: 1, sticky_messages: [], skill_gets: [] };
  }
  if (!isPlainObject(existing) || existing.schema_version !== 1
    || !Array.isArray(existing.sticky_messages) || !Array.isArray(existing.skill_gets)) {
    throw new Error(`Invalid compact memory schema: ${filePath}`);
  }
  if (existing.sticky_messages.some(message => !isPlainObject(message)
    || typeof message.delivery_id !== "string" || message.delivery_id === ""
    || typeof message.subject !== "string")) {
    throw new Error(`Invalid sticky message record: ${filePath}`);
  }
  if (existing.skill_gets.some(argv => !Array.isArray(argv) || argv.length < 4
    || argv[0] !== "agentgear" || argv[1] !== "skill" || argv[2] !== "get"
    || argv.some(value => typeof value !== "string"))) {
    throw new Error(`Invalid Agentgear skill-get record: ${filePath}`);
  }
  return {
    schema_version: 1,
    sticky_messages: existing.sticky_messages.map(message => ({
      delivery_id: message.delivery_id,
      subject: message.subject
    })),
    skill_gets: existing.skill_gets.map(argv => [...argv])
  };
}

function writeMemory(root, memory) {
  writeJsonAtomic(memoryFile(root), {
    ...memory,
    sticky_messages: memory.sticky_messages.slice(-STICKY_MESSAGE_LIMIT),
    skill_gets: memory.skill_gets.slice(-SKILL_GET_LIMIT)
  });
}

export function recordStickyMessages(input, { env = process.env } = {}) {
  const root = sessionMemoryDirectory(input.session_id, env);
  const memory = readMemory(root);
  const seen = new Set(memory.sticky_messages.map(message => message.delivery_id));
  let recorded = 0;
  for (const candidate of stickyMessageCandidates(input.tool_response)) {
    if (typeof candidate.delivery_id !== "string" || candidate.delivery_id === "" || seen.has(candidate.delivery_id)) continue;
    seen.add(candidate.delivery_id);
    memory.sticky_messages.push({
      delivery_id: candidate.delivery_id,
      subject: typeof candidate.subject === "string" ? candidate.subject : ""
    });
    recorded += 1;
  }
  if (recorded > 0) writeMemory(root, memory);
  return recorded;
}

function splitDirectCommand(command, { platform = process.platform } = {}) {
  if (typeof command !== "string" || !command.trim() || command.includes("\n") || command.includes("\0")) return null;
  const words = [];
  let source = command.trim();
  if (source.startsWith("&")) {
    if (platform !== "win32" || !/^&[ \t]+/u.test(source)) return null;
    words.push("&");
    source = source.slice(1).trimStart();
    if (!source) return null;
  }
  let word = "";
  let quote = null;
  let escaped = false;
  let started = false;
  const finish = () => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };
  for (const character of source) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && platform !== "win32") escaped = true;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      finish();
    } else if (";&|<>()`".includes(character) || character === "$") {
      return null;
    } else if (character === "\\" && platform !== "win32") {
      escaped = true;
      started = true;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote || escaped) return null;
  finish();
  return words;
}

function commandBasename(command) {
  return path.basename(command.replaceAll("\\", "/")).toLowerCase().replace(/\.(?:cmd|exe)$/u, "");
}

export function agentgearSkillGetArgv(command, options = {}) {
  const words = splitDirectCommand(command, options);
  if (!words || words.length < 4) return null;
  if (words[0] === "&") words.shift();
  if (commandBasename(words[0]) !== "agentgear" || words[1] !== "skill" || words[2] !== "get") return null;
  const args = words.slice(3);
  if (args.length === 0 || args.some(value => !/^[A-Za-z0-9][A-Za-z0-9._:/+,-]*$|^--(?:agent-profile)?$/u.test(value))) return null;
  return ["agentgear", "skill", "get", ...args];
}

function bashCommand(input) {
  return isPlainObject(input.tool_input) && typeof input.tool_input.command === "string"
    ? input.tool_input.command
    : null;
}

export function recordSkillGet(input, {
  env = process.env,
  platform = process.platform
} = {}) {
  if (responseFailed(input.tool_response)) return false;
  const argv = agentgearSkillGetArgv(bashCommand(input), { platform });
  if (!argv) return false;
  const root = sessionMemoryDirectory(input.session_id, env);
  const memory = readMemory(root);
  const encoded = JSON.stringify(argv);
  if (memory.skill_gets.some(call => JSON.stringify(call) === encoded)) return false;
  memory.skill_gets.push(argv);
  writeMemory(root, memory);
  return true;
}

function waypostToolName(toolName) {
  return typeof toolName === "string" && /(?:^|__)waypost_(?:recv|read)$/u.test(toolName);
}

function directWaypostReadCommand(command, options = {}) {
  const words = splitDirectCommand(command, options);
  if (!words || words.length < 2) return false;
  if (words[0] === "&") words.shift();
  if (commandBasename(words[0]) !== "waypost") return false;
  const json = words.some(word => word === "--json" || word === "--json=true");
  const yaml = words.some(word => word === "--yaml" || word === "--yaml=true");
  if (!json || yaml) return false;
  let index = 1;
  if (words[index] === "--state-dir") index += 2;
  else if (words[index]?.startsWith("--state-dir=")) index += 1;
  return ["recv", "read"].includes(words[index]);
}

export function handlePostToolUse(input, options = {}) {
  if (input.hook_event_name !== "PostToolUse") return;
  if (waypostToolName(input.tool_name)
    || (input.tool_name === "Bash" && directWaypostReadCommand(bashCommand(input), options))) {
    recordStickyMessages(input, options);
  }
  if (input.tool_name === "Bash") recordSkillGet(input, options);
}

function shellDisplay(argv) {
  return argv.map(value => /^[A-Za-z0-9._:/+,-]+$/u.test(value) ? value : JSON.stringify(value)).join(" ");
}

function dataDisplay(value) {
  return JSON.stringify(String(value));
}

function boundedErrorDetail(error) {
  const detail = error instanceof Error ? error.message : String(error);
  const characters = Array.from(detail);
  if (characters.length <= ERROR_DETAIL_LIMIT) return detail;
  const marker = "…";
  const head = Math.floor(ERROR_DETAIL_LIMIT / 2);
  const tail = ERROR_DETAIL_LIMIT - head - Array.from(marker).length;
  return `${characters.slice(0, head).join("")}${marker}${characters.slice(-tail).join("")}`;
}

function memoryFailureOutput(action, error) {
  return {
    systemMessage: `Agentgear compact memory was not ${action}: ${boundedErrorDetail(error)}`
  };
}

export function compactAdditionalContext(sessionId, { env = process.env } = {}) {
  const root = sessionMemoryDirectory(sessionId, env);
  const memory = readMemory(root);
  const messages = memory.sticky_messages.slice(-STICKY_MESSAGE_LIMIT);
  const calls = memory.skill_gets.slice(-SKILL_GET_LIMIT);
  if (messages.length === 0 && calls.length === 0) return null;
  const lines = [];
  if (messages.length > 0) {
    lines.push("Sticky Waypost tasks already received:");
    for (const message of messages) {
      const subject = message.subject || "(no subject)";
      lines.push(`- delivery=${dataDisplay(message.delivery_id)} subject=${dataDisplay(subject)}`);
    }
    lines.push("Missing details: run `waypost read <delivery-id> --json`.");
  }
  if (calls.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Earlier `agentgear skill get` calls (rerun if needed):");
    for (const call of calls) lines.push(`- ${shellDisplay(call.slice(3))}`);
  }
  return lines.join("\n");
}

export function handleHook(input, options = {}) {
  if (!isPlainObject(input)) throw new Error("Codex hook input must be a JSON object");
  if (input.hook_event_name === "Stop") {
    try {
      return handleStop(input, options);
    } catch (error) {
      return memoryFailureOutput("recorded recovery state", error);
    }
  }
  if (input.hook_event_name === "PostToolUse") {
    try {
      handlePostToolUse(input, options);
    } catch (error) {
      return memoryFailureOutput("updated", error);
    }
    return null;
  }
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return null;
  let additionalContext;
  try {
    additionalContext = compactAdditionalContext(input.session_id, options);
  } catch (error) {
    return memoryFailureOutput("restored", error);
  }
  if (!additionalContext) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  };
}

export function runCompactMemoryHook({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const source = fs.readFileSync(stdin.fd, "utf8");
  const input = JSON.parse(source);
  const output = handleHook(input, { env });
  if (output) stdout.write(`${JSON.stringify(output)}\n`);
}

function existingRealpath(filePath) {
  if (!filePath) return null;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const invokedFile = existingRealpath(process.argv[1]);
if (invokedFile === thisFile) {
  try {
    runCompactMemoryHook();
  } catch (error) {
    process.stderr.write(`agentgear compact-memory-hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
