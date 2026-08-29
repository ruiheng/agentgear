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
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    return fallback;
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
  const existing = readJson(memoryFile(root), {});
  return {
    schema_version: 1,
    sticky_messages: Array.isArray(existing?.sticky_messages)
      ? existing.sticky_messages.filter(message => isPlainObject(message) && typeof message.delivery_id === "string")
      : [],
    skill_gets: Array.isArray(existing?.skill_gets)
      ? existing.skill_gets.filter(argv => Array.isArray(argv))
      : []
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
    lines.push("If task details are missing, read the relevant delivery by ID; do not use recv.");
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
  if (input.hook_event_name === "PostToolUse") {
    handlePostToolUse(input, options);
    return null;
  }
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return null;
  const additionalContext = compactAdditionalContext(input.session_id, options);
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
