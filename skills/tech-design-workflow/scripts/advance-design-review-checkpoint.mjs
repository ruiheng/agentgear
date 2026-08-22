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

const usage = `Advance a design lane's review checkpoint after the user chooses to continue.

Required:
  --workdir <path>
  --lane-manifest <workspace-relative-path>
  --expected-current-checkpoint <positive-integer>

Optional:
  --json
  -h, --help`;

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value || "")) fail(`${label} must be a positive integer`);
  return Number(value);
}

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

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: ["--workdir", "--lane-manifest", "--expected-current-checkpoint"],
    flags: ["--json"],
    defaults: { json: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [
    ["workdir", "--workdir"],
    ["laneManifest", "--lane-manifest"],
    ["expectedCurrentCheckpoint", "--expected-current-checkpoint"]
  ]) if (!options[key]) fail(`${label} is required`);

  const requestedWorkdir = path.resolve(options.workdir);
  if (!fs.statSync(requestedWorkdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${requestedWorkdir}`);
  }
  const workdir = fs.realpathSync(requestedWorkdir);
  const manifestFile = resolveManifest(workdir, options.laneManifest);
  const manifest = readJson(manifestFile);
  if (manifest?.schema_version !== 1) fail("design lane manifest has an unsupported schema");
  if (!Number.isInteger(manifest.review_checkpoint) || manifest.review_checkpoint <= 0) {
    fail("lane manifest review_checkpoint is invalid");
  }
  if (!Number.isInteger(manifest.review_checkpoint_interval) || manifest.review_checkpoint_interval <= 0) {
    fail("lane manifest review_checkpoint_interval is invalid");
  }

  const expected = positiveInteger(options.expectedCurrentCheckpoint, "--expected-current-checkpoint");
  if (manifest.review_checkpoint !== expected) {
    fail("review checkpoint changed; reread the manifest before advancing it");
  }
  const next = expected + manifest.review_checkpoint_interval;

  manifest.review_checkpoint = next;
  (dependencies.writeJsonAtomic || writeJsonAtomic)(manifestFile, manifest);
  const summary = {
    status: "updated",
    previous_review_checkpoint: expected,
    review_checkpoint: next,
    review_checkpoint_interval: manifest.review_checkpoint_interval
  };
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : `Design review checkpoint advanced: ${expected} -> ${next}\n`);
}

if (isMain(import.meta.url)) execute(main);
