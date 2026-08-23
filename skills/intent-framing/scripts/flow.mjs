#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  execute,
  fail,
  isMain,
  nowIso,
  parseArgs,
  writeJsonAtomic
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";

const MODES = new Set(["sequence", "roundtable"]);
const FLOW_STATUSES = new Set(["active", "stopped"]);
const APPEND_KINDS = new Map([
  ["question", "Question"],
  ["user", "User"],
  ["contribution", "Contribution"],
  ["complete", "Complete"]
]);

const usage = `Manage an intent-framing artifact directory.

Commands:
  init --workdir <path> --flow-id <id> --mode <sequence|roundtable> --input-file <path>
  add-context --workdir <path> --flow-id <id> --body-file <path>
  add-framer --workdir <path> --flow-id <id> --framer-id <id> --model <model> --launcher <launcher> [--instruction-file <path>]
  activate-framer --workdir <path> --flow-id <id> --framer-id <id> --session-id <id> --session-host <host> --session-address <address> --return-address <address>
  append-framer --workdir <path> --flow-id <id> --framer-id <id> --kind <question|user|contribution|complete> --body-file <path>
  set-flow --workdir <path> --flow-id <id> --status <active|stopped>
  set-roundtable --workdir <path> --flow-id <id> --roundtable-id <id> --group-address <address>
  add-synthesis --workdir <path> --flow-id <id> --body-file <path>`;

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    fail(`${label} must be one path-safe identifier`);
  }
  return value;
}

function oneLine(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    fail(`${label} must be non-empty single-line text`);
  }
  return value.trim();
}

function realDirectory(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  const resolved = path.resolve(value);
  const info = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!info?.isDirectory()) fail(`${label} is not a directory: ${value}`);
  return fs.realpathSync(resolved);
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireNoSymlinkComponents(parent, candidate, label) {
  if (!pathInside(parent, candidate)) fail(`${label} escapes the workdir`);
  let current = parent;
  for (const component of path.relative(parent, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${current}`);
  }
}

function pathsFor(workdirValue, flowIdValue) {
  const workdir = realDirectory(workdirValue, "--workdir");
  const flowId = safeSegment(flowIdValue, "--flow-id");
  const base = path.join(workdir, ".agent-artifacts", "intent-framing");
  const root = path.join(base, flowId);
  requireNoSymlinkComponents(workdir, root, "flow path");
  return {
    workdir,
    flowId,
    base,
    root,
    manifest: path.join(root, "manifest.json"),
    input: path.join(root, "input.md"),
    additions: path.join(root, "additions"),
    framers: path.join(root, "framers"),
    roundtable: path.join(root, "roundtable")
  };
}

function readBodyFile(value, label = "--body-file") {
  if (typeof value !== "string" || !value) fail(`${label} is required`);
  const resolved = path.resolve(value);
  const info = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${label} is missing or unsafe: ${value}`);
  const body = fs.readFileSync(resolved, "utf8");
  if (!body.trim()) fail(`${label} is empty: ${value}`);
  return body;
}

function readManifest(paths) {
  const info = fs.lstatSync(paths.manifest, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`flow manifest not found: ${paths.manifest}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  } catch {
    fail(`invalid flow manifest: ${paths.manifest}`);
  }
  if (manifest?.schema_version !== 1 || manifest.flow_id !== paths.flowId || !MODES.has(manifest.mode)) {
    fail(`flow manifest identity mismatch: ${paths.manifest}`);
  }
  return manifest;
}

function writeManifest(paths, manifest) {
  manifest.updated_at = nowIso();
  writeJsonAtomic(paths.manifest, manifest);
}

function requireActive(manifest) {
  if (manifest.status !== "active") fail(`flow is not active: ${manifest.status}`);
}

function requireSafeArtifactPath(paths, filePath, label) {
  requireNoSymlinkComponents(paths.root, filePath, label);
  const parent = fs.lstatSync(path.dirname(filePath), { throwIfNoEntry: false });
  if (!parent?.isDirectory() || parent.isSymbolicLink()) {
    fail(`${label} parent is missing or unsafe: ${path.dirname(filePath)}`);
  }
}

function nextSequence(directory) {
  const entries = fs.readdirSync(directory);
  return entries.reduce((largest, entry) => {
    const match = /^(\d+)-/.exec(entry);
    return match ? Math.max(largest, Number(match[1])) : largest;
  }, 0) + 1;
}

function writeNumbered(paths, directory, stem, body, label) {
  const sequence = nextSequence(directory);
  const filePath = path.join(directory, `${String(sequence).padStart(3, "0")}-${stem}.md`);
  requireSafeArtifactPath(paths, filePath, label);
  fs.writeFileSync(filePath, body, { flag: "wx" });
  return { path: filePath, sequence };
}

function findFramerFile(paths, framerId, required = true) {
  const id = safeSegment(framerId, "--framer-id");
  const entry = fs.readdirSync(paths.framers).find(candidate => {
    const match = /^\d+-(.+)\.md$/.exec(candidate);
    return match?.[1] === id;
  });
  if (!entry && required) fail(`unknown framer: ${id}`);
  return entry ? path.join(paths.framers, entry) : null;
}

function markdownCode(value) {
  return value.replace(/`/g, "\\`");
}

function emit(value) {
  process.stdout.write(`${value.path || value.status || "ok"}\n`);
}

export function initFlow({ workdir, flowId, mode, inputFile }) {
  if (!MODES.has(mode)) fail("--mode must be sequence or roundtable");
  const paths = pathsFor(workdir, flowId);
  const input = readBodyFile(inputFile, "--input-file");
  if (fs.existsSync(paths.root)) fail(`flow already exists: ${paths.root}`);

  fs.mkdirSync(paths.base, { recursive: true });
  requireNoSymlinkComponents(paths.workdir, paths.base, "artifact root");
  const temporary = fs.mkdtempSync(path.join(paths.base, `.${paths.flowId}.`));
  let committed = false;
  try {
    fs.mkdirSync(path.join(temporary, "additions"));
    fs.mkdirSync(path.join(temporary, mode === "sequence" ? "framers" : "roundtable"));
    fs.writeFileSync(path.join(temporary, "input.md"), input, { flag: "wx" });
    const createdAt = nowIso();
    writeJsonAtomic(path.join(temporary, "manifest.json"), {
      schema_version: 1,
      flow_id: paths.flowId,
      mode,
      status: "active",
      created_at: createdAt,
      updated_at: createdAt,
      current_framer: null,
      roundtable: null
    });
    fs.renameSync(temporary, paths.root);
    committed = true;
  } finally {
    if (!committed) fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { path: paths.root, manifest: paths.manifest, input: paths.input };
}

export function addContext({ workdir, flowId, bodyFile }) {
  const paths = pathsFor(workdir, flowId);
  requireActive(readManifest(paths));
  return writeNumbered(paths, paths.additions, "context", readBodyFile(bodyFile), "context artifact");
}

export function addFramer({ workdir, flowId, framerId, model, launcher, instructionFile = null }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  requireActive(manifest);
  if (manifest.mode !== "sequence") fail("framers are available only in sequence mode");
  const id = safeSegment(framerId, "--framer-id");
  if (findFramerFile(paths, id, false)) fail(`duplicate framer id: ${id}`);
  const modelName = oneLine(model, "--model");
  const launcherName = oneLine(launcher, "--launcher");
  const instruction = instructionFile ? readBodyFile(instructionFile, "--instruction-file") : null;
  const sequence = nextSequence(paths.framers);
  const filePath = path.join(paths.framers, `${String(sequence).padStart(3, "0")}-${id}.md`);
  requireSafeArtifactPath(paths, filePath, "framer artifact");
  const blocks = [
    `<!-- intent-framing ${JSON.stringify({ framer: id, model: modelName, launcher: launcherName })} -->`,
    "",
    `# Intent Framer ${sequence}`,
    "",
    `- Framer: \`${markdownCode(id)}\``,
    `- Model: \`${markdownCode(modelName)}\``
  ];
  if (instruction) blocks.push("", "## Focus", "", instruction);
  blocks.push("", "## Record", "");
  fs.writeFileSync(filePath, blocks.join("\n"), { flag: "wx" });
  return { path: filePath, sequence, id };
}

export function activateFramer({ workdir, flowId, framerId, sessionId, sessionHost, sessionAddress, returnAddress }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  requireActive(manifest);
  if (manifest.mode !== "sequence") fail("framer sessions require sequence mode");
  const filePath = findFramerFile(paths, framerId);
  requireSafeArtifactPath(paths, filePath, "framer artifact");
  manifest.current_framer = {
    id: safeSegment(framerId, "--framer-id"),
    path: path.relative(paths.root, filePath).split(path.sep).join("/"),
    session: {
      id: oneLine(sessionId, "--session-id"),
      host: oneLine(sessionHost, "--session-host"),
      address: oneLine(sessionAddress, "--session-address")
    },
    return_address: oneLine(returnAddress, "--return-address")
  };
  writeManifest(paths, manifest);
  return { path: filePath, status: "active" };
}

export function appendFramer({ workdir, flowId, framerId, kind, bodyFile }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  requireActive(manifest);
  const heading = APPEND_KINDS.get(kind);
  if (!heading) fail("invalid --kind for append-framer");
  const filePath = findFramerFile(paths, framerId);
  const relativePath = path.relative(paths.root, filePath).split(path.sep).join("/");
  if (manifest.current_framer?.id !== framerId || manifest.current_framer.path !== relativePath) {
    fail(`framer is not current: ${framerId}`);
  }
  requireSafeArtifactPath(paths, filePath, "framer artifact");
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`framer artifact is missing or unsafe: ${filePath}`);
  const body = readBodyFile(bodyFile);
  const existing = fs.readFileSync(filePath, "utf8");
  fs.appendFileSync(filePath, `${existing.endsWith("\n") ? "\n" : "\n\n"}## ${heading}\n\n${body}`);
  return { path: filePath, status: kind };
}

export function setFlow({ workdir, flowId, status }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  if (!FLOW_STATUSES.has(status)) fail(`invalid flow status: ${status}`);
  manifest.status = status;
  writeManifest(paths, manifest);
  return { path: paths.root, status };
}

export function setRoundtable({ workdir, flowId, roundtableId, groupAddress }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  requireActive(manifest);
  if (manifest.mode !== "roundtable") fail("roundtable metadata requires roundtable mode");
  const identity = {
    id: oneLine(roundtableId, "--roundtable-id"),
    group_address: oneLine(groupAddress, "--group-address")
  };
  if (manifest.roundtable) {
    if (manifest.roundtable.id !== identity.id || manifest.roundtable.group_address !== identity.group_address) {
      fail("roundtable identity is already bound");
    }
    return { path: paths.roundtable, status: manifest.status };
  }
  manifest.roundtable = identity;
  writeManifest(paths, manifest);
  return { path: paths.roundtable, status: manifest.status };
}

export function addSynthesis({ workdir, flowId, bodyFile }) {
  const paths = pathsFor(workdir, flowId);
  const manifest = readManifest(paths);
  requireActive(manifest);
  if (manifest.mode !== "roundtable") fail("syntheses require roundtable mode");
  return writeNumbered(paths, paths.roundtable, "synthesis", readBodyFile(bodyFile), "roundtable synthesis");
}

export function showFlow({ workdir, flowId }) {
  return readManifest(pathsFor(workdir, flowId));
}

function commandOptions(argv) {
  return parseArgs(argv, {
    values: [
      "--workdir", "--flow-id", "--mode", "--input-file", "--body-file",
      "--framer-id", "--model", "--launcher", "--instruction-file", "--kind", "--status",
      "--session-id", "--session-host", "--session-address", "--return-address",
      "--roundtable-id", "--group-address"
    ]
  });
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const options = commandOptions(argv.slice(1));
  if (options._.length > 0) fail(`unexpected args: ${options._.join(" ")}`);
  const common = { workdir: options.workdir, flowId: options.flowId };
  let result;
  if (command === "init") result = initFlow({ ...common, mode: options.mode, inputFile: options.inputFile });
  else if (command === "add-context") result = addContext({ ...common, bodyFile: options.bodyFile });
  else if (command === "add-framer") result = addFramer({ ...common, framerId: options.framerId, model: options.model, launcher: options.launcher, instructionFile: options.instructionFile });
  else if (command === "activate-framer") result = activateFramer({
    ...common,
    framerId: options.framerId,
    sessionId: options.sessionId,
    sessionHost: options.sessionHost,
    sessionAddress: options.sessionAddress,
    returnAddress: options.returnAddress
  });
  else if (command === "append-framer") result = appendFramer({ ...common, framerId: options.framerId, kind: options.kind, bodyFile: options.bodyFile });
  else if (command === "set-flow") result = setFlow({ ...common, status: options.status });
  else if (command === "set-roundtable") result = setRoundtable({ ...common, roundtableId: options.roundtableId, groupAddress: options.groupAddress });
  else if (command === "add-synthesis") result = addSynthesis({ ...common, bodyFile: options.bodyFile });
  else fail(`unknown command: ${command}`);
  emit(result);
}

if (isMain(import.meta.url)) execute(() => main());
