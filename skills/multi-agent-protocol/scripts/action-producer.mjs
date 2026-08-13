import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, run } from "./workflow-lib.mjs";

const ACTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTION_NAME = /^[A-Z][A-Z0-9_]*$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|cjs|js)$/;
const FACTORY_NAME = /^[a-z][A-Za-z0-9]*Message$/;
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

function actionMessage(declaration, beforeHeader, afterHeader) {
  if (typeof beforeHeader !== "string" || typeof afterHeader !== "string") {
    fail("Waypost Action message requires string body sections");
  }
  const message = Object.freeze({});
  messageBodies.set(message, `${beforeHeader}${actionHeader(declaration)}${afterHeader}`);
  messageDeclarations.set(message, actionDeclaration(declaration));
  return message;
}

// Each skill's fixed action-producers module may load only its adjacent
// manifest. Every resulting factory is branded to exactly one token/script.
export function loadActionProducerManifest(moduleUrl) {
  const { definition, manifestPath } = readProducerManifest(moduleUrl);
  const scriptsDirectory = path.join(path.dirname(manifestPath), "scripts");
  const actions = {};
  const factories = {};
  const seenTokens = new Set();
  const seenFactories = new Set();
  for (const [name, declaration] of Object.entries(definition.actions)) {
    if (!ACTION_NAME.test(name) || !declaration || typeof declaration !== "object" || Array.isArray(declaration)
      || typeof declaration.token !== "string" || !ACTION_TOKEN.test(declaration.token)
      || declaration.export !== name || typeof declaration.script !== "string" || !SCRIPT_NAME.test(declaration.script)
      || typeof declaration.factory !== "string" || !FACTORY_NAME.test(declaration.factory)
      || seenTokens.has(declaration.token) || seenFactories.has(declaration.factory)) {
      fail(`Action producer manifest has an invalid action declaration: ${manifestPath}`);
    }
    const script = path.join(scriptsDirectory, declaration.script);
    const scriptInfo = fs.lstatSync(script, { throwIfNoEntry: false });
    if (!scriptInfo?.isFile() || scriptInfo.isSymbolicLink()) {
      fail(`Action producer script is missing or unsafe: ${script}`);
    }
    const value = Object.freeze({});
    declaredActionsByValue.set(value, Object.freeze({ name, token: declaration.token, script }));
    actions[name] = value;
    factories[name] = Object.freeze((beforeHeader, afterHeader) => actionMessage(value, beforeHeader, afterHeader));
    seenTokens.add(declaration.token);
    seenFactories.add(declaration.factory);
  }
  if (seenTokens.size === 0) fail(`Action producer manifest must declare at least one action: ${manifestPath}`);
  return Object.freeze({ actions: Object.freeze(actions), factories: Object.freeze(factories) });
}

function actionMessageBody(message) {
  const body = message && typeof message === "object" ? messageBodies.get(message) : undefined;
  if (body === undefined) fail("Waypost send requires a declared Action message");
  return body;
}

// This is the only helper that unwraps a branded Action message and writes a
// Waypost body. The sender module must exactly match the declared script.
export function sendActionMessage(message, senderModuleUrl, {
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
  const declaration = message && typeof message === "object" ? messageDeclarations.get(message) : undefined;
  if (!declaration) fail("Waypost send requires a declared Action message");
  let senderPath;
  try {
    senderPath = fileURLToPath(senderModuleUrl);
  } catch {
    fail("Waypost Action sender must provide its module URL");
  }
  if (path.resolve(senderPath) !== declaration.script) {
    fail(`Waypost Action ${declaration.name} is not declared for sender: ${senderPath}`);
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
