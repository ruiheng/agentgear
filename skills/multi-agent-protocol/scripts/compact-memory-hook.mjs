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
const ERROR_DETAIL_LIMIT = 500;

function stateHome(env) {
  const home = env.HOME || os.homedir();
  return env.XDG_STATE_HOME || path.join(home, ".local", "state");
}

export function sessionMemoryDirectory(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("hook input is missing session_id");
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
  if (response.isError === true || response.is_error === true || response.success === false
    || response.interrupted === true) return true;
  for (const field of ["exit_code", "exitCode", "returnCode"]) {
    if (Number.isInteger(response[field]) && response[field] !== 0) return true;
  }
  return false;
}

function responseRoots(response) {
  if (responseFailed(response)) return [];
  const roots = [response];
  if (isPlainObject(response)) {
    for (const field of ["structuredContent", "structured_content", "output", "stdout"]) {
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

// A shell command line is recognized as the set of invocations it may run.
// shellScan is the single lexical pass used for everything: it renders words
// (quotes, escapes, and $( )/backquote/${ } spans stay atomic inside their
// word), marks &&/||/;/|/&/( )/{ } operators as segment boundaries, and drops
// redirections with their targets. commandCallArgvs splits the tokens into
// segments and resolves each — keyword and VAR= prefixes, env/sudo-style
// wrappers, sh -c strings — into candidate argvs.
//
// The recognizer is deliberately approximate: multi-line commands are not
// recognized (keeping heredoc bodies out of scope), eval is not expanded, and
// unparseable input yields no invocations. It exists to feed a fail-open
// recorder — it must not be reused for denial or policy decisions, where
// these gaps become bypasses.

const SHELL_SEGMENT_BOUNDARIES = "&|;(){}";
const SHELL_MAX_DEPTH = 64;

// The wrapper, -c shell, and prefix tables mirror hookcore/command.go in
// agent-mailbox (WaypostCommands); keep them in sync. `exec` is recognized
// here in addition — `exec waypost ...` replaces the shell with the target.
const SHELL_COMMAND_WRAPPERS = new Set([
  "builtin", "command", "doas", "env", "exec",
  "nice", "nohup", "stdbuf", "sudo", "time", "watch", "xargs"
]);
const SHELL_DASH_C_COMMANDS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);
const SHELL_COMMAND_PREFIXES = new Set([
  "if", "elif", "while", "until", "do", "then", "else", "coproc", "!"
]);
const SHELL_ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const SHELL_TARGET_EXECUTABLES = new Set(["waypost", "agentgear"]);

// shellScan scans source[start..] as shell text and returns {tokens, next}:
// word tokens ({type:"word", text}) in rendered form, operator tokens
// ({type:"op"}) for each segment boundary, and no tokens for redirections.
// `close` ends the scan at an unmatched close delimiter — ")" for $( ),
// "}" for ${ }, "`" for backquotes — or null at top level. The token list of
// every $( ) and backquote substitution is appended to the shared
// `substitutions` in encounter order. Returns null on unterminated or
// unbalanced input.
function shellScan(source, start, platform, close, substitutions, level) {
  if (level > SHELL_MAX_DEPTH) return null;
  const open = close === ")" ? "(" : close === "}" ? "{" : null;
  const tokens = [];
  let word = "";
  let started = false;
  let quote = null;
  let escaped = false;
  let depth = 0;
  let dropNext = false;
  let i = start;
  const finishWord = () => {
    if (!started) return;
    if (!dropNext) tokens.push({ type: "word", text: word });
    dropNext = false;
    word = "";
    started = false;
  };
  const substitution = (openIndex, innerClose) => {
    const inner = shellScan(source, openIndex + 1, platform, innerClose, substitutions, level + 1);
    if (!inner) return false;
    if (innerClose === ")" || innerClose === "`") substitutions.push(inner.tokens);
    word += source.slice(i, inner.next);
    started = true;
    i = inner.next;
    return true;
  };
  while (i < source.length) {
    const ch = source[i];
    if (escaped) { word += ch; escaped = false; i += 1; continue; }
    if (quote === "'" || quote === "$'") {
      if (ch === "'") quote = null;
      else if (ch === "\\" && quote === "$'" && platform !== "win32") escaped = true;
      else word += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; i += 1; continue; }
      if (ch === "\\" && platform !== "win32") { escaped = true; i += 1; continue; }
      if (ch === "`") {
        if (!substitution(i, "`")) return null;
        continue;
      }
      if (ch === "$" && source[i + 1] === "(") {
        if (!substitution(i + 1, ")")) return null;
        continue;
      }
      word += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && platform !== "win32") { escaped = true; i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; started = true; i += 1; continue; }
    if (ch === "`" && close === "`") {
      finishWord();
      return { tokens, next: i + 1 };
    }
    if (ch === "`" || (ch === "$" && source[i + 1] === "(")) {
      if (!substitution(ch === "`" ? i : i + 1, ch === "`" ? "`" : ")")) return null;
      continue;
    }
    if (ch === "$") {
      const next = source[i + 1];
      if (next === "{") {
        // ${ } bodies are not command lines; the scan still runs so command
        // substitutions nested inside (e.g. ${x:-$(cmd)}) are collected.
        if (!substitution(i + 1, "}")) return null;
        continue;
      }
      if (next === "'" || next === '"') { quote = next === "'" ? "$'" : next; started = true; i += 2; continue; }
      word += ch;
      started = true;
      i += 1;
      continue;
    }
    if (SHELL_SEGMENT_BOUNDARIES.includes(ch)) {
      finishWord();
      if (open) {
        if (ch === close && depth === 0) return { tokens, next: i + 1 };
        if (ch === open) depth += 1;
        else if (ch === close) depth -= 1;
      }
      tokens.push({ type: "op", op: ch });
      i += 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A pending all-digit word is a file-descriptor prefix (`2>f`), not an argument.
      if (/^\d+$/u.test(word)) { word = ""; started = false; }
      finishWord();
      i += 1;
      while (i < source.length && (source[i] === "<" || source[i] === ">")) i += 1;
      if (source[i] === "&") i += 1;   // `>&` fuses the fd duplication
      // The redirect target is the next word, attached or separated.
      dropNext = true;
      continue;
    }
    if (/\s/u.test(ch)) { finishWord(); i += 1; continue; }
    word += ch;
    started = true;
    i += 1;
  }
  if (quote || escaped || close !== null) return null;
  finishWord();
  return { tokens, next: i };
}

// dashCCommandText returns the command line a `sh -c`-style call interprets.
function dashCCommandText(argv) {
  for (let i = 1; i < argv.length - 1; i += 1) {
    const flag = argv[i];
    if (flag === "-c" || (/^-[^-]/u.test(flag) && flag.slice(1).includes("c"))) return argv[i + 1];
  }
  return null;
}

// commandCallArgvs returns an argv for every waypost/agentgear invocation in a
// shell command line: compound commands, command substitutions, subshells,
// wrapper commands (env, sudo, ...), and `sh -c` strings are all recognized,
// while a target merely mentioned inside quoted arguments or another
// command's operands is not.
export function commandCallArgvs(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const calls = [];
  const pendingTexts = [command];
  const pendingTokenLists = [];
  const resolveSegment = (words) => {
    let start = 0;
    while (start < words.length
      && (SHELL_COMMAND_PREFIXES.has(words[start]) || SHELL_ASSIGNMENT_WORD.test(words[start]))) {
      start += 1;
    }
    const argv = words.slice(start);
    if (argv.length === 0) return;
    const base = commandBasename(argv[0]);
    if (SHELL_COMMAND_WRAPPERS.has(base)) {
      for (let k = 1; k < argv.length; k += 1) {
        const wrapped = commandBasename(argv[k]);
        if (SHELL_TARGET_EXECUTABLES.has(wrapped)) { calls.push(argv.slice(k)); break; }
        if (SHELL_DASH_C_COMMANDS.has(wrapped)) {
          const inner = dashCCommandText(argv.slice(k));
          if (inner !== null) pendingTexts.push(inner);
          break;
        }
      }
    } else if (SHELL_DASH_C_COMMANDS.has(base)) {
      const inner = dashCCommandText(argv);
      if (inner !== null) pendingTexts.push(inner);
    } else if (SHELL_TARGET_EXECUTABLES.has(base)) {
      calls.push(argv);
    }
  };
  while (pendingTexts.length > 0 || pendingTokenLists.length > 0) {
    if (pendingTexts.length > 0) {
      let source = pendingTexts.shift();
      if (typeof source !== "string") continue;
      source = source.trim();
      // A leading `&` is the Windows PowerShell invocation prefix.
      if (source.startsWith("&")) source = source.slice(1).trimStart();
      if (!source || source.includes("\n") || source.includes("\0")) continue;
      const substitutions = [];
      const scanned = shellScan(source, 0, platform, null, substitutions, 0);
      if (!scanned) continue;
      pendingTokenLists.push(scanned.tokens, ...substitutions);
      continue;
    }
    let segment = [];
    for (const token of pendingTokenLists.shift()) {
      if (token.type === "op") {
        if (segment.length > 0) resolveSegment(segment);
        segment = [];
      } else {
        segment.push(token.text);
      }
    }
    if (segment.length > 0) resolveSegment(segment);
  }
  return calls;
}

function commandBasename(command) {
  return path.basename(command.replaceAll("\\", "/")).toLowerCase().replace(/\.(?:cmd|exe)$/u, "");
}

export function agentgearSkillGetArgvs(command, options = {}) {
  const argvs = [];
  for (const argv of commandCallArgvs(command, options)) {
    if (commandBasename(argv[0]) !== "agentgear" || argv[1] !== "skill" || argv[2] !== "get") continue;
    const args = argv.slice(3);
    if (args.length === 0 || args.some(value => !/^[A-Za-z0-9][A-Za-z0-9._:/+,-]*$|^--(?:agent-profile)?$/u.test(value))) continue;
    argvs.push(["agentgear", "skill", "get", ...args]);
  }
  return argvs;
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
  const argvs = agentgearSkillGetArgvs(bashCommand(input), { platform });
  if (argvs.length === 0) return false;
  const root = sessionMemoryDirectory(input.session_id, env);
  const memory = readMemory(root);
  const recorded = new Set(memory.skill_gets.map(call => JSON.stringify(call)));
  let changed = false;
  for (const argv of argvs) {
    const encoded = JSON.stringify(argv);
    if (recorded.has(encoded)) continue;
    recorded.add(encoded);
    memory.skill_gets.push(argv);
    changed = true;
  }
  if (!changed) return false;
  writeMemory(root, memory);
  return true;
}

function waypostToolName(toolName) {
  return typeof toolName === "string" && /(?:^|__)waypost_(?:recv|read)$/u.test(toolName);
}

function runsWaypostReadCommand(command, options = {}) {
  for (const argv of commandCallArgvs(command, options)) {
    if (commandBasename(argv[0]) !== "waypost" || argv.length < 2) continue;
    const json = argv.some(word => word === "--json" || word === "--json=true");
    const yaml = argv.some(word => word === "--yaml" || word === "--yaml=true");
    if (!json || yaml) continue;
    let index = 1;
    while (index < argv.length) {
      if (argv[index] === "--state-dir") index += 2;
      else if (argv[index].startsWith("--state-dir=")) index += 1;
      else break;
    }
    if (["recv", "receive", "read"].includes(argv[index])) return true;
  }
  return false;
}

const SHELL_TOOL_NAMES = new Set(["Bash", "exec"]);

export function handlePostToolUse(input, options = {}) {
  if (input.hook_event_name !== "PostToolUse") return;
  if (waypostToolName(input.tool_name)
    || (SHELL_TOOL_NAMES.has(input.tool_name) && runsWaypostReadCommand(bashCommand(input), options))) {
    recordStickyMessages(input, options);
  }
  if (SHELL_TOOL_NAMES.has(input.tool_name)) recordSkillGet(input, options);
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

const PENDING_CONTEXT_FILE = "pending-context.json";

function pendingContextFile(root) {
  return path.join(root, PENDING_CONTEXT_FILE);
}

// PostCompaction context output is ignored by some hosts (Devin accepts the
// hook output but never injects its additionalContext). Marking the session
// pending lets the next PostToolUse or UserPromptSubmit event deliver the
// reminder through an event whose additionalContext is honored.
function markPendingContext(root) {
  writeJsonAtomic(pendingContextFile(root), { marked_at: new Date().toISOString() });
}

function takePendingContext(root) {
  const file = pendingContextFile(root);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function takePendingSession(input, env) {
  if (typeof input.session_id !== "string" || !input.session_id) return false;
  return takePendingContext(sessionMemoryDirectory(input.session_id, env));
}

function contextOutput(sessionId, hookEventName, options) {
  const additionalContext = compactAdditionalContext(sessionId, options);
  if (!additionalContext) return null;
  return { hookSpecificOutput: { hookEventName, additionalContext } };
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

export const HANDLED_EVENTS = Object.freeze([
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "PostCompaction"
]);

export function handleHook(input, options = {}) {
  if (!isPlainObject(input)) throw new Error("hook input must be a JSON object");
  const env = options.env || process.env;
  if (!HANDLED_EVENTS.includes(input.hook_event_name)) return null;
  if (input.hook_event_name === "PostToolUse") {
    let failure = null;
    try {
      handlePostToolUse(input, options);
    } catch (error) {
      failure = memoryFailureOutput("updated", error);
    }
    try {
      if (!takePendingSession(input, env)) return failure;
      return contextOutput(input.session_id, "PostToolUse", options) ?? failure;
    } catch (error) {
      return failure ?? memoryFailureOutput("restored", error);
    }
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    try {
      if (!takePendingSession(input, env)) return null;
      return contextOutput(input.session_id, "UserPromptSubmit", options);
    } catch (error) {
      return memoryFailureOutput("restored", error);
    }
  }
  if (input.hook_event_name === "SessionStart") {
    try {
      const pending = takePendingSession(input, env);
      if (!pending && input.source === "startup") return null;
      return contextOutput(input.session_id, "SessionStart", options);
    } catch (error) {
      return memoryFailureOutput("restored", error);
    }
  }
  if (input.hook_event_name === "PostCompaction") {
    try {
      const context = compactAdditionalContext(input.session_id, options);
      if (!context) return null;
      markPendingContext(sessionMemoryDirectory(input.session_id, env));
      return { hookSpecificOutput: { hookEventName: "PostCompaction", additionalContext: context } };
    } catch (error) {
      return memoryFailureOutput("restored", error);
    }
  }
  return null;
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
