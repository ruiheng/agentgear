import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function regularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizedDecimal(literal) {
  const match = literal.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const explicitExponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(explicitExponent)) return null;
  let exponent = explicitExponent - fraction.length;
  if (!Number.isSafeInteger(exponent)) return null;
  let coefficient = BigInt(`${match[2]}${fraction}`);
  if (match[1] === "-") coefficient = -coefficient;
  if (coefficient === 0n) return "0e0";
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1;
  }
  return `${coefficient}e${exponent}`;
}

function jsonNumberRoundTrips(literal) {
  const value = Number(literal);
  if (!Number.isFinite(value)) return false;
  return normalizedDecimal(literal) === normalizedDecimal(JSON.stringify(value));
}

function firstUnsafeJsonNumber(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== "-" && !/[0-9]/u.test(character)) continue;
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) continue;
    const literal = match[0];
    if (!jsonNumberRoundTrips(literal)) return literal;
    index += literal.length - 1;
  }
  return null;
}

export function refuseUnsafeRewrite(filePath, literal, label) {
  if (!literal) return;
  const characters = Array.from(literal);
  const display = characters.length <= 80
    ? literal
    : `${characters.slice(0, 39).join("")}…${characters.slice(-40).join("")}`;
  throw new Error(`Cannot safely rewrite ${label} ${filePath}: JSON number ${display} cannot round-trip safely`);
}

export function readHookDocument(filePath, label) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return {
      value,
      mode: fs.statSync(filePath).mode & 0o777,
      unsafeNumber: firstUnsafeJsonNumber(text)
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, mode: 0o600, unsafeNumber: null };
    throw new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
  }
}

export function validateHookGroups(value, filePath, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} field must be an object: ${filePath}`);
  }
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) throw new Error(`${label}.${event} must be an array: ${filePath}`);
    for (const [groupIndex, group] of groups.entries()) {
      if (!isPlainObject(group)) throw new Error(`${label}.${event}[${groupIndex}] must be an object: ${filePath}`);
      if (group.matcher !== undefined && group.matcher !== null && typeof group.matcher !== "string") {
        throw new Error(`${label}.${event}[${groupIndex}].matcher must be a string: ${filePath}`);
      }
      if (!Array.isArray(group.hooks)) {
        throw new Error(`${label}.${event}[${groupIndex}].hooks must be an array: ${filePath}`);
      }
      for (const [handlerIndex, handlerValue] of group.hooks.entries()) {
        if (!isPlainObject(handlerValue)) {
          throw new Error(`${label}.${event}[${groupIndex}].hooks[${handlerIndex}] must be an object: ${filePath}`);
        }
      }
    }
  }
  return value;
}

function existingWritePath(filePath) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (info) return fs.realpathSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return filePath;
}

export function writeHookDocument(filePath, value, mode) {
  const target = existingWritePath(filePath);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
