import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, run } from "./workflow-lib.mjs";
import { appendStickyTaskContextMarker } from "./compact-memory-shared.mjs";

const ACTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTION_NAME = /^[A-Z][A-Z0-9_]*$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|cjs|js)$/;
const FACTORY_NAME = /^[a-z][A-Za-z0-9]*Message$/;
const SENDER_NAME = /^[a-z][A-Za-z0-9]*Message$/;
// Existing workflow envelopes use descriptive labels such as "Session host".
// Keep those labels intact while still accepting only one physical header line.
const HEADER_NAME = /^[A-Za-z](?:[A-Za-z0-9 -]*[A-Za-z0-9])?$/;
const MANIFEST_FILE = "action-producers.json";
const MODULE_FILE = "action-producers.mjs";
const declaredActionsByValue = new WeakMap();
const messageBodies = new WeakMap();
const messageDeclarations = new WeakMap();

function readProducerManifest(moduleUrl) {
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    fail("Action producer module must provide its module URL");
  }
  if (path.basename(modulePath) !== MODULE_FILE || path.basename(path.dirname(modulePath)) !== "scripts") {
    fail("Action producer declarations may only load from scripts/action-producers.mjs");
  }
  const manifestPath = path.join(path.dirname(path.dirname(modulePath)), MANIFEST_FILE);
  const info = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    fail(`Action producer manifest is missing or unsafe: ${manifestPath}`);
  }
  let definition;
  try {
    definition = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail(`Action producer manifest is invalid JSON: ${manifestPath}`);
  }
  if (!definition || definition.schemaVersion !== 1 || definition.module !== MODULE_FILE
    || !definition.actions || typeof definition.actions !== "object" || Array.isArray(definition.actions)) {
    fail(`Action producer manifest must declare schemaVersion 1 actions: ${manifestPath}`);
  }
  return { definition, manifestPath };
}

function actionDeclaration(declaration) {
  const value = declaration && typeof declaration === "object"
    ? declaredActionsByValue.get(declaration)
    : undefined;
  if (!value) fail("Waypost Action header requires a declared Action value");
  return value;
}

export function actionHeader(declaration) {
  return `Action: ${actionDeclaration(declaration).token}`;
}

function hasExactOwnKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every(key => keys.includes(key));
}

function snapshotHeaderField(field, label, index) {
  if (!field || typeof field !== "object" || Array.isArray(field)
    || !hasExactOwnKeys(field, ["name", "value"])) {
    fail(`Waypost Action message ${label} header ${index + 1} must have string name and value`);
  }
  // Read untrusted getters/proxies exactly once, then validate and emit only
  // these primitive snapshots rather than re-reading caller-owned objects.
  const name = field.name;
  const value = field.value;
  if (typeof name !== "string" || typeof value !== "string") {
    fail(`Waypost Action message ${label} header ${index + 1} must have string name and value`);
  }
  return Object.freeze({ name, value });
}

function headerFields(fields, label, seen) {
  if (!Array.isArray(fields)) fail(`Waypost Action message ${label} headers must be an array`);
  const result = [];
  for (let index = 0; index < fields.length; index += 1) {
    if (!Object.hasOwn(fields, index)) {
      fail(`Waypost Action message ${label} header ${index + 1} must have string name and value`);
    }
    const field = fields[index];
    const { name, value } = snapshotHeaderField(field, label, index);
    if (!HEADER_NAME.test(name)) {
      fail(`Waypost Action message ${label} header ${index + 1} has an invalid name`);
    }
    const normalizedName = name.toLowerCase();
    if (normalizedName === "action") {
      fail("Waypost Action message headers may not set Action");
    }
    if (normalizedName === "from" || normalizedName === "to") {
      fail(`Waypost Action message headers may not duplicate transport ${name}`);
    }
    if (seen.has(normalizedName)) {
      fail(`Waypost Action message has duplicate header ${name}`);
    }
    if (value.length === 0 || /[\r\n\0]/.test(value)) {
      fail(`Waypost Action message ${label} header ${name} has an unsafe value`);
    }
    seen.add(normalizedName);
    result.push(`${name}: ${value}`);
  }
  return result;
}

function actionMessage(declaration, envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || !hasExactOwnKeys(envelope, ["before", "after", "body"])) {
    fail("Waypost Action message requires structured headers and a string body");
  }
  const beforeHeaders = envelope.before;
  const afterHeaders = envelope.after;
  const body = envelope.body;
  if (typeof body !== "string") fail("Waypost Action message requires structured headers and a string body");
  const seenHeaders = new Set();
  const before = headerFields(beforeHeaders, "before", seenHeaders);
  const after = headerFields(afterHeaders, "after", seenHeaders);
  const declarationValue = actionDeclaration(declaration);
  const initialEnvelope = [...before, actionHeader(declaration), ...after].join("\n");
  const message = Object.freeze({});
  const messageBody = `${initialEnvelope}\n\n${body}`;
  messageBodies.set(message, declarationValue.sticky
    ? appendStickyTaskContextMarker(messageBody)
    : messageBody);
  messageDeclarations.set(message, declaration);
  return message;
}

// Each skill's fixed action-producers module may load only its adjacent
// manifest. Every resulting factory is branded to exactly one token/script.
export function loadActionProducerManifest(moduleUrl) {
  const { definition, manifestPath } = readProducerManifest(moduleUrl);
  const scriptsDirectory = path.join(path.dirname(manifestPath), "scripts");
  const actions = {};
  const factories = {};
  const senders = {};
  const seenTokens = new Set();
  const seenFactories = new Set();
  const seenSenders = new Set();
  for (const [name, declaration] of Object.entries(definition.actions)) {
    if (!ACTION_NAME.test(name) || !declaration || typeof declaration !== "object" || Array.isArray(declaration)
      || typeof declaration.token !== "string" || !ACTION_TOKEN.test(declaration.token)
      || declaration.export !== name || typeof declaration.script !== "string" || !SCRIPT_NAME.test(declaration.script)
      || typeof declaration.sticky !== "boolean"
      || typeof declaration.factory !== "string" || !FACTORY_NAME.test(declaration.factory)
      || typeof declaration.sender !== "string" || !SENDER_NAME.test(declaration.sender)
      || seenTokens.has(declaration.token) || seenFactories.has(declaration.factory) || seenSenders.has(declaration.sender)) {
      fail(`Action producer manifest has an invalid action declaration: ${manifestPath}`);
    }
    const script = path.join(scriptsDirectory, declaration.script);
    const scriptInfo = fs.lstatSync(script, { throwIfNoEntry: false });
    if (!scriptInfo?.isFile() || scriptInfo.isSymbolicLink()) {
      fail(`Action producer script is missing or unsafe: ${script}`);
    }
    const value = Object.freeze({});
    declaredActionsByValue.set(value, Object.freeze({ name, token: declaration.token, script, sticky: declaration.sticky }));
    actions[name] = value;
    factories[name] = Object.freeze(envelope => actionMessage(value, envelope));
    senders[name] = Object.freeze((message, options) => sendDeclaredActionMessage(value, message, options));
    seenTokens.add(declaration.token);
    seenFactories.add(declaration.factory);
    seenSenders.add(declaration.sender);
  }
  if (seenTokens.size === 0) fail(`Action producer manifest must declare at least one action: ${manifestPath}`);
  return Object.freeze({ actions: Object.freeze(actions), factories: Object.freeze(factories), senders: Object.freeze(senders) });
}

function actionMessageBody(message) {
  const body = message && typeof message === "object" ? messageBodies.get(message) : undefined;
  if (body === undefined) fail("Waypost send requires a declared Action message");
  return body;
}

// This is the only helper that unwraps a branded Action message and writes a
// Waypost body. loadActionProducerManifest binds each exposed sender closure
// to one declaration, so callers cannot supply or spoof a sender URL.
function sendDeclaredActionMessage(declaration, message, {
  toAddress,
  fromAddress,
  subject,
  contentType,
  schemaVersion,
  sendTimeoutMs = 0,
  runCommand = run
} = {}) {
  for (const [value, label] of [
    [toAddress, "Waypost Action destination"],
    [fromAddress, "Waypost Action sender"],
    [subject, "Waypost Action subject"],
    [contentType, "Waypost Action content type"],
    [schemaVersion, "Waypost Action schema version"]
  ]) {
    if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  }
  if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 0) {
    fail("Waypost Action send timeout must be a non-negative integer");
  }
  if (typeof runCommand !== "function") fail("Waypost Action send requires a structured transport callback");
  const messageDeclaration = message && typeof message === "object" ? messageDeclarations.get(message) : undefined;
  if (!messageDeclaration) fail("Waypost send requires a declared Action message");
  if (messageDeclaration !== declaration) {
    fail("Waypost Action message does not match its declared producer route");
  }
  return runCommand("waypost", [
    "send", "--to", toAddress,
    "--from", fromAddress,
    "--subject", subject,
    "--content-type", contentType,
    "--schema-version", schemaVersion,
    "--body-file", "-",
    "--notify",
    "--json"
  ], { input: actionMessageBody(message), timeoutMs: sendTimeoutMs });
}
