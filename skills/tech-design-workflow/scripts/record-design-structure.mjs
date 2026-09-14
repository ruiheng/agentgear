#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  execute,
  fail,
  isMain,
  parseArgs,
  readJson,
  writeJsonAtomic
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";
import { requireSymlinkFreeContainedPath } from "./send-design-draft-with-review-context.mjs";

const usage = `Record a design lane's accepted structure document, or open a structural amendment.

Required:
  --workdir <path>
  --lane-manifest <workspace-relative-path>
  Exactly one of:
    --structure-doc <workspace-relative-path>
                                  Record the structure artifact the requester has
                                  accepted. Implementation dispatches must name it
                                  via --structure-doc. The path must be an existing
                                  sNNN.md artifact of this lane's author whose round
                                  is at least the previously recorded one. Recording
                                  clears structure_amendment_pending; re-recording
                                  the current document closes an amendment that
                                  resolved without a structural change.
    --open-amendment              Declare that an implementation-phase finding rolls
                                  back to structure. Blocks implementation dispatch
                                  until a new structure document is recorded.

Optional:
  --json
  -h, --help

The lane manifest is the lane's source of truth: this script is the only writer
of structure_doc and structure_amendment_pending.`;

function resolveManifest(workdir, relativePath) {
  if (path.isAbsolute(relativePath)) fail("--lane-manifest must be workspace-relative");
  const file = path.resolve(workdir, relativePath);
  const relative = path.relative(workdir, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("--lane-manifest escapes --workdir");
  }
  requireSymlinkFreeContainedPath(workdir, path.dirname(file), "lane manifest parent");
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`lane manifest is not a safe regular file: ${file}`);
  return file;
}

function resolveWorkspaceFile(workdir, relativePath, label) {
  if (path.isAbsolute(relativePath)) fail(`${label} must be workspace-relative`);
  const filePath = path.resolve(workdir, relativePath);
  const relative = path.relative(workdir, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} escapes the current workspace`);
  }
  requireSymlinkFreeContainedPath(workdir, path.dirname(filePath), `${label} parent`);
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${label} is not a safe regular file: ${filePath}`);
  return filePath;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--lane-manifest", "--structure-doc"],
    flags: ["--open-amendment", "--json"],
    defaults: { json: false, openAmendment: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [["workdir", "--workdir"], ["laneManifest", "--lane-manifest"]]) {
    if (!options[key]) fail(`${label} is required`);
  }
  if (Boolean(options.structureDoc) === options.openAmendment) {
    fail("provide exactly one of --structure-doc or --open-amendment");
  }

  const requestedWorkdir = path.resolve(options.workdir);
  if (!fs.statSync(requestedWorkdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${requestedWorkdir}`);
  }
  const workdir = fs.realpathSync(requestedWorkdir);
  const manifestFile = resolveManifest(workdir, options.laneManifest);
  const manifest = readJson(manifestFile);
  if (manifest?.schema_version !== 2) fail("design lane manifest must use schema 2");
  if (manifest.design_phases !== "two") fail("structure recording is only valid for a two-phase lane");
  if (typeof manifest.author_session_id !== "string" || !manifest.author_session_id) {
    fail("lane manifest author_session_id is invalid");
  }

  const summary = { status: "updated", task_id: manifest.task_id };
  if (options.openAmendment) {
    if (!manifest.structure_doc) {
      fail("no structure document is recorded yet; a pending amendment only makes sense after acceptance");
    }
    manifest.structure_amendment_pending = true;
    summary.structure_doc = manifest.structure_doc;
    summary.structure_amendment_pending = true;
  } else {
    const match = /^s([0-9]{3,})\.md$/.exec(path.posix.basename(options.structureDoc));
    const prefix = path.posix.join(".agent-artifacts", "design-spec", manifest.author_session_id);
    if (!match || path.posix.dirname(options.structureDoc) !== prefix) {
      fail("--structure-doc must be an sNNN.md artifact of this lane's author");
    }
    const round = Number(match[1]);
    if (manifest.structure_doc) {
      const current = Number(/^s([0-9]{3,})\.md$/.exec(path.posix.basename(manifest.structure_doc))?.[1] || 0);
      if (round < current) {
        fail("--structure-doc must not move the accepted structure backwards");
      }
    }
    resolveWorkspaceFile(workdir, options.structureDoc, "--structure-doc");
    manifest.structure_doc = options.structureDoc;
    delete manifest.structure_amendment_pending;
    summary.structure_doc = options.structureDoc;
    summary.structure_amendment_pending = false;
  }
  (dependencies.writeJsonAtomic || writeJsonAtomic)(manifestFile, manifest);
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : options.openAmendment
      ? `Structure amendment opened: ${manifest.task_id} (implementation dispatch blocked)\n`
      : `Structure document recorded: ${manifest.task_id} -> ${options.structureDoc}\n`);
}

if (isMain(import.meta.url)) execute(main);
