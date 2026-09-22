// Session notes: short user-pinned instructions scoped to one session.
//
// Notes live in <session dir>/notes.json next to the compact-memory state.
// Writers that know the session (the managed hook) apply ops directly;
// writers that do not (skill scripts run by the agent) append ops to a
// cwd-keyed inbox file that the next hook event claims into its session.
//
// Ops: {op:"add", text} | {op:"remove", index|text} | {op:"clear"} | {op:"list"}.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isPlainObject,
  readJson,
  stateHome,
  writeJsonAtomic
} from "./compact-memory-shared.mjs";

export const NOTES_LIMIT = 16;
export const NOTE_TEXT_LIMIT = 500;
export const INBOX_OP_TTL_MS = 5 * 60 * 1000;

export function untouched() {
  return { touched: false, applied: 0, errors: [], notes: undefined };
}

// One command grammar shared by the prompt-capture path ("/…remember …") and
// the session-notes script (argv): a leading verb plus free text. Verbs:
// add | forget|remove|rm|delete | clear|reset | list|ls|show.
const REMOVE_VERBS = new Set(["forget", "remove", "rm", "delete"]);
const CLEAR_VERBS = new Set(["clear", "reset"]);
const LIST_VERBS = new Set(["list", "ls", "show"]);
const KNOWN_VERBS = new Set(["add", ...REMOVE_VERBS, ...CLEAR_VERBS, ...LIST_VERBS]);

// Maps an explicit verb + argument text to an op or an error message.
export function noteCommandOp(verb, argument) {
  const text = (argument ?? "").trim();
  if (REMOVE_VERBS.has(verb)) {
    if (!text) return { error: "remove requires a number or note text" };
    return {
      op: /^\d+$/.test(text)
        ? { op: "remove", index: Number.parseInt(text, 10) }
        : { op: "remove", text }
    };
  }
  if (verb === "add") {
    if (!text) return { error: "add requires note text" };
    if ([...text].length > NOTE_TEXT_LIMIT) return { error: `note exceeds ${NOTE_TEXT_LIMIT} characters` };
    return { op: { op: "add", text } };
  }
  if (CLEAR_VERBS.has(verb)) return { op: { op: "clear" } };
  if (LIST_VERBS.has(verb)) return { op: { op: "list" } };
  return { error: `unknown command: ${verb}` };
}

// Prompt form: "/…remember <argument>". Argument-taking verbs (add,
// forget/remove/rm/delete) act as a leading verb; zero-arg verbs
// (clear/reset, list/ls/show) only count when they are the entire argument —
// otherwise "/remember clear the table" would wipe the list instead of
// pinning a rule. Anything else is note text.
export function opsFromNoteArgument(argument) {
  const arg = (argument ?? "").trim();
  if (!arg) return { ops: [{ op: "list" }], errors: [] };
  const space = arg.search(/[ \t]/);
  const first = (space === -1 ? arg : arg.slice(0, space)).toLowerCase();
  const isVerb = space === -1 ? KNOWN_VERBS.has(first) : first === "add" || REMOVE_VERBS.has(first);
  const result = isVerb
    ? noteCommandOp(first, space === -1 ? "" : arg.slice(space + 1))
    : noteCommandOp("add", arg);
  return result.op ? { ops: [result.op], errors: [] } : { ops: [], errors: [result.error] };
}

function inboxKey(cwd) {
  if (typeof cwd !== "string" || !cwd) throw new Error("cwd is required to locate the session inbox");
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex");
}

export function inboxFile(cwd, env = process.env) {
  return path.join(stateHome(env), "agentgear", "session-inbox", `${inboxKey(cwd)}.jsonl`);
}

export function notesFile(sessionDir) {
  return path.join(sessionDir, "notes.json");
}

export function normalizeOp(raw) {
  if (!isPlainObject(raw) || typeof raw.op !== "string") return null;
  if (raw.op === "add") {
    return typeof raw.text === "string" ? { op: "add", text: raw.text } : null;
  }
  if (raw.op === "remove") {
    if (Number.isInteger(raw.index)) return { op: "remove", index: raw.index };
    if (typeof raw.text === "string") return { op: "remove", text: raw.text };
    return null;
  }
  if (raw.op === "clear" || raw.op === "list") return { op: raw.op };
  return null;
}

export function readNotes(sessionDir) {
  const filePath = notesFile(sessionDir);
  const existing = readJson(filePath);
  if (existing === undefined) return { schema_version: 1, notes: [] };
  if (!isPlainObject(existing) || existing.schema_version !== 1
    || !Array.isArray(existing.notes)
    || existing.notes.some(note => !isPlainObject(note)
      || typeof note.text !== "string" || typeof note.created_at !== "string")) {
    throw new Error(`Invalid session notes schema: ${filePath}`);
  }
  return {
    schema_version: 1,
    notes: existing.notes.map(note => ({ text: note.text, created_at: note.created_at }))
  };
}

export function applyOps(memory, ops, { now = new Date() } = {}) {
  const notes = memory.notes.map(note => ({ ...note }));
  let applied = 0;
  const errors = [];
  for (const raw of ops) {
    const op = normalizeOp(raw);
    if (op === null) {
      errors.push("skipped malformed op");
      continue;
    }
    if (op.op === "list") {
      applied += 1;
      continue;
    }
    if (op.op === "clear") {
      notes.length = 0;
      applied += 1;
      continue;
    }
    if (op.op === "add") {
      const text = op.text.trim();
      if (!text) { errors.push("empty note text"); continue; }
      if ([...text].length > NOTE_TEXT_LIMIT) {
        errors.push(`note exceeds ${NOTE_TEXT_LIMIT} characters`);
        continue;
      }
      if (notes.some(note => note.text === text)) { applied += 1; continue; }
      if (notes.length >= NOTES_LIMIT) {
        errors.push(`session notes full (max ${NOTES_LIMIT})`);
        continue;
      }
      notes.push({ text, created_at: now.toISOString() });
      applied += 1;
      continue;
    }
    // op.op === "remove"
    let index = -1;
    if (op.index !== undefined) index = op.index - 1;
    else index = notes.findIndex(note => note.text === op.text.trim());
    if (index < 0 || index >= notes.length) {
      errors.push(op.index !== undefined ? `no note #${op.index}` : "no matching note text");
      continue;
    }
    notes.splice(index, 1);
    applied += 1;
  }
  return { memory: { schema_version: 1, notes }, applied, errors };
}

export function applyOpsToSession(sessionDir, ops, options = {}) {
  const memory = readNotes(sessionDir);
  const result = applyOps(memory, ops, options);
  if (JSON.stringify(result.memory) !== JSON.stringify(memory)) {
    writeJsonAtomic(notesFile(sessionDir), result.memory);
  }
  return {
    touched: result.applied > 0 || result.errors.length > 0,
    applied: result.applied,
    errors: result.errors,
    notes: result.memory.notes
  };
}

export function appendInboxOp(cwd, op, env = process.env) {
  const normalized = normalizeOp(op);
  if (normalized === null) throw new Error(`invalid session-notes op: ${JSON.stringify(op)}`);
  const filePath = inboxFile(cwd, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify({ ...normalized, ts: new Date().toISOString() })}\n`, "utf8");
  return filePath;
}

export function readInboxOps(cwd, env = process.env) {
  const filePath = inboxFile(cwd, env);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n")
    .map(line => {
      if (!line.trim()) return null;
      try { return JSON.parse(line); } catch { return { op: "__malformed__" }; }
    })
    .filter(Boolean);
}

export function claimInbox(cwd, sessionDir, { env = process.env, now } = {}) {
  const filePath = inboxFile(cwd, env);
  if (!fs.existsSync(filePath)) return untouched();
  // Ops are meant to be claimed by the queuing session's next hook event
  // (seconds). Older entries are dropped so an abandoned queue cannot leak
  // notes into a later session sharing the same working directory.
  const claimedAt = now ? new Date(now) : new Date();
  const ops = [];
  const errors = [];
  let stale = 0;
  for (const entry of readInboxOps(cwd, env)) {
    if (entry.op === "__malformed__") {
      errors.push("skipped malformed inbox line");
      continue;
    }
    const queuedAt = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
    if (Number.isFinite(queuedAt) && claimedAt.getTime() - queuedAt > INBOX_OP_TTL_MS) {
      stale += 1;
      continue;
    }
    ops.push(entry);
  }
  if (stale > 0) errors.push(`dropped ${stale} stale session-note op(s)`);
  const result = applyOpsToSession(sessionDir, ops, { now });
  fs.rmSync(filePath, { force: true });
  return {
    touched: result.touched || errors.length > 0,
    applied: result.applied,
    errors: [...errors, ...result.errors],
    notes: result.notes
  };
}
