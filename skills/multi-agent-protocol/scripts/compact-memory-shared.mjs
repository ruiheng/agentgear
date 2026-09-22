import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STICKY_TASK_CONTEXT_MARKER = "Keep this task context across compaction.";

export function hasStickyTaskContextMarker(body) {
  if (typeof body !== "string") return false;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  return lines.length > 0 && lines.at(-1) === STICKY_TASK_CONTEXT_MARKER;
}

export function appendStickyTaskContextMarker(body) {
  if (typeof body !== "string") throw new TypeError("Sticky task context body must be a string");
  if (hasStickyTaskContextMarker(body)) return body;
  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${STICKY_TASK_CONTEXT_MARKER}\n`;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stateHome(env) {
  const home = env.HOME || os.homedir();
  return env.XDG_STATE_HOME || path.join(home, ".local", "state");
}

export function sessionMemoryDirectory(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("hook input is missing session_id");
  const key = crypto.createHash("sha256").update(sessionId).digest("hex");
  return path.join(stateHome(env), "agentgear", "compact-memory", key);
}

export function writeJsonAtomic(filePath, value) {
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

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read compact memory ${filePath}: ${error.message}`, { cause: error });
  }
}
