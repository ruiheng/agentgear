#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  execute,
  fail,
  isMain,
  nowIso,
  parseArgs,
  requireCommand,
  run,
  writeJsonAtomic,
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";

const usage = `Prepare reviewer-owned state for one design review round.

Usage:
  prepare-incremental-review.mjs \\
    --workdir <workspace> \\
    --task-id <task-id> \\
    --reviewer-session-id <session-id> \\
    --round <positive-integer> \\
    --current-artifact <.agent-artifacts/design-spec/.../rNNN.md> \\
    [--previous-artifact <.agent-artifacts/design-spec/.../rNNN.md>] \\
    [--record-evidence <repository-relative-file>]... \\
    [--json]
`;

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function requireSingleSegment(value, label) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    fail(`${label} must be one path segment`);
  }
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireSymlinkFreeContainedPath(root, candidate, label, requireFile = false) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!pathIsInside(resolvedRoot, resolvedCandidate)) fail(`${label} must be inside --workdir`);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  const parts = relative ? relative.split(path.sep) : [];
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      if (requireFile) fail(`${label} does not exist: ${current}`);
      break;
    }
    if (info.isSymbolicLink()) fail(`${label} must not contain symlink components: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) fail(`${label} has a non-directory component: ${current}`);
    if (index === parts.length - 1 && requireFile && !info.isFile()) fail(`${label} must be a regular file: ${current}`);
  }
  return resolvedCandidate;
}

function normalizeRelative(value, label) {
  if (!value || path.isAbsolute(value)) fail(`${label} must be workspace-relative`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) fail(`${label} must be inside --workdir`);
  return normalized;
}

function artifactDescriptor(value, round, label) {
  const normalized = normalizeRelative(value, label);
  const parts = normalized.split(path.sep);
  const expectedName = `r${String(round).padStart(3, "0")}.md`;
  const valid = parts.length === 4 && parts[0] === ".agent-artifacts" &&
    parts[1] === "design-spec" && parts[2] && parts[2] !== "." && parts[2] !== ".." &&
    parts[3] === expectedName;
  if (!valid) fail(`${label} must equal .agent-artifacts/design-spec/<author-session-id>/${expectedName}`);
  requireSingleSegment(parts[2], `${label} author session id`);
  return { relative: parts.join("/"), native: normalized, authorSessionId: parts[2] };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitOutput(workdir, args, runCommand = run) {
  const result = runCommand("git", args, { cwd: workdir });
  if (result.error) fail(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    fail(detail ? `git ${args.join(" ")} failed: ${detail}` : `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function machineDiff(workdir, previousRelative, currentRelative, runCommand = run) {
  const result = runCommand("git", [
    "diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--",
    previousRelative, currentRelative,
  ], { cwd: workdir });
  if (result.error) fail(`machine diff failed: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    const detail = (result.stderr || result.stdout).trim();
    fail(detail ? `machine diff failed: ${detail}` : "machine diff failed");
  }
  return result.stdout;
}

function evidenceTemplate(taskId, reviewerSessionId) {
  return `# Evidence Index

- Task: ${taskId}
- Reviewer: ${reviewerSessionId}
- Machine cache: \`review-state.json\`

Only the architect-reviewer may edit this file. Treat entries as an investigation cache, not task authority. Use stable IDs and mark each entry \`verified\`, \`stale\`, \`rejected\`, or \`superseded\`.

## Entries

<!--
### E-001 — <conclusion>
- Status: verified
- Verified in round: 1
- Last confirmed in round: 1
- Evidence: path/to/file: symbol or range
- Repository baseline: <HEAD and relevant file hashes>
- Conclusion: <narrow verified fact>
- Invalidated by: <specific file, interface, invariant, or scope changes>
-->
`;
}

function ledgerTemplate(taskId, reviewerSessionId) {
  return `# Review Ledger

- Task: ${taskId}
- Reviewer: ${reviewerSessionId}

Only the architect-reviewer may edit this file. Keep stable Finding IDs across rounds; never renumber history.

## Findings

<!--
### R1-F01 — <finding>
- Status: open
- Opened in round: 1
- Closed/reopened in round: pending
- Affected sections: <design sections>
- Evidence: E-001
- Rationale: <why it is open, accepted, or reopened>
-->
`;
}

function readState(stateFile) {
  const info = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) fail(`reviewer state must be a regular file: ${stateFile}`);
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    fail(`failed to read reviewer state: ${stateFile}`);
  }
}

function writeTextAtomic(filePath, value) {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail(`generated review output must be a regular file: ${filePath}`);
  }
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, value, { flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ensureReviewerMarkdown(filePath, value, label) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular file: ${filePath}`);
    return;
  }
  try {
    fs.writeFileSync(filePath, value, { flag: "wx" });
  } catch (error) {
    fail(`failed to create ${label}: ${error.message}`);
  }
}

function staleEvidence(workdir, evidenceFiles) {
  const stale = [];
  for (const [relative, recorded] of Object.entries(evidenceFiles || {}).sort(([left], [right]) => left.localeCompare(right))) {
    const candidate = path.join(workdir, relative);
    const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      stale.push({ path: relative, reason: "missing_or_not_regular", recorded_sha256: recorded.sha256 });
      continue;
    }
    const current = sha256File(candidate);
    if (current !== recorded.sha256) {
      stale.push({ path: relative, reason: "content_changed", recorded_sha256: recorded.sha256, current_sha256: current });
    }
  }
  return stale;
}

function recordEvidence(workdir, values, evidenceFiles, round) {
  for (const raw of values) {
    const relativeNative = normalizeRelative(raw, "--record-evidence");
    const parts = relativeNative.split(path.sep);
    if (parts[0] === ".agent-artifacts") fail("--record-evidence must name repository evidence, not workflow artifacts");
    const absolute = requireSymlinkFreeContainedPath(workdir, path.join(workdir, relativeNative), "--record-evidence", true);
    const relative = path.relative(workdir, absolute).split(path.sep).join("/");
    evidenceFiles[relative] = {
      sha256: sha256File(absolute),
      recorded_round: round,
      recorded_at: nowIso(),
    };
  }
}

export function prepareIncrementalReview(rawOptions, dependencies = {}) {
  const runCommand = dependencies.run || run;
  const writeState = dependencies.writeJsonAtomic || writeJsonAtomic;
  requireCommand("git");

  const taskId = rawOptions.taskId;
  const reviewerSessionId = rawOptions.reviewerSessionId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId || "")) {
    fail("--task-id must use letters, digits, dot, underscore, or hyphen");
  }
  requireSingleSegment(reviewerSessionId, "--reviewer-session-id");
  const round = positiveInteger(rawOptions.round, "--round");
  if (round > 999) fail("--round must be at most 999");

  if (!fs.statSync(rawOptions.workdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${rawOptions.workdir}`);
  }
  const workdir = fs.realpathSync(rawOptions.workdir);
  const current = artifactDescriptor(rawOptions.currentArtifact, round, "--current-artifact");
  const currentAbsolute = requireSymlinkFreeContainedPath(workdir, path.join(workdir, current.native), "--current-artifact", true);

  let previous = null;
  let previousAbsolute = null;
  if (round === 1) {
    if (rawOptions.previousArtifact) fail("--previous-artifact is not valid for round 1");
  } else {
    if (!rawOptions.previousArtifact) fail("--previous-artifact is required for round 2 and later");
    previous = artifactDescriptor(rawOptions.previousArtifact, round - 1, "--previous-artifact");
    if (previous.authorSessionId !== current.authorSessionId) {
      fail("current and previous artifacts must belong to the same author session");
    }
    previousAbsolute = requireSymlinkFreeContainedPath(workdir, path.join(workdir, previous.native), "--previous-artifact", true);
  }

  const stateRoot = path.join(workdir, ".agent-artifacts", "design-review", reviewerSessionId, taskId);
  requireSymlinkFreeContainedPath(workdir, stateRoot, "review state directory");
  fs.mkdirSync(stateRoot, { recursive: true });
  requireSymlinkFreeContainedPath(workdir, stateRoot, "review state directory");

  const stateFile = path.join(stateRoot, "review-state.json");
  const evidenceIndex = path.join(stateRoot, "evidence-index.md");
  const reviewLedger = path.join(stateRoot, "review-ledger.md");
  const state = readState(stateFile) || {
    schema_version: 1,
    task_id: taskId,
    reviewer_session_id: reviewerSessionId,
    evidence_files: {},
    rounds: {},
  };
  if (state.schema_version !== 1 || state.task_id !== taskId || state.reviewer_session_id !== reviewerSessionId) {
    fail("reviewer state identity does not match the requested lane");
  }
  if (Number(state.latest_round || 0) > round) fail("cannot prepare an older round after a later round");

  const currentSha256 = sha256File(currentAbsolute);
  const previousSha256 = previousAbsolute ? sha256File(previousAbsolute) : null;
  const existingRound = state.rounds[String(round)];
  if (existingRound) {
    if (
      existingRound.current_artifact !== current.relative ||
      existingRound.current_artifact_sha256 !== currentSha256 ||
      (existingRound.previous_artifact || null) !== (previous?.relative || null) ||
      (existingRound.previous_artifact_sha256 || null) !== previousSha256
    ) {
      fail(`round ${round} was already prepared with a different immutable target or baseline`);
    }
  }
  if (round > 1) {
    const priorRound = state.rounds[String(round - 1)];
    if (!priorRound) fail(`reviewer state is missing prepared round ${round - 1}`);
    if (priorRound.current_artifact !== previous.relative || priorRound.current_artifact_sha256 !== previousSha256) {
      fail("--previous-artifact does not match the preceding reviewed target or it was modified after review");
    }
  }

  const beforeRecording = staleEvidence(workdir, state.evidence_files);
  recordEvidence(workdir, rawOptions.recordEvidence || [], state.evidence_files, round);
  const stale = staleEvidence(workdir, state.evidence_files);

  const repoHead = gitOutput(workdir, ["rev-parse", "HEAD"], runCommand);
  const worktreeStatus = gitOutput(workdir, [
    "status", "--short", "--untracked-files=all", "--", ".", ":(exclude).agent-artifacts",
  ], runCommand);
  const priorPreparedRound = round > 1 ? state.rounds[String(round - 1)] : null;
  const repoHeadChanged = Boolean(priorPreparedRound && priorPreparedRound.repo_head !== repoHead);
  const worktreeChanged = Boolean(priorPreparedRound && priorPreparedRound.worktree_status_sha256 !== sha256Text(worktreeStatus));

  let diffFile = null;
  let diffSha256 = null;
  let diffEmpty = null;
  if (previous) {
    const diff = machineDiff(workdir, previous.relative, current.relative, runCommand);
    diffFile = path.join(stateRoot, `r${String(round).padStart(3, "0")}-from-r${String(round - 1).padStart(3, "0")}.diff`);
    writeTextAtomic(diffFile, diff);
    diffSha256 = sha256Text(diff);
    diffEmpty = diff.length === 0;
  }

  ensureReviewerMarkdown(evidenceIndex, evidenceTemplate(taskId, reviewerSessionId), "Evidence Index");
  ensureReviewerMarkdown(reviewLedger, ledgerTemplate(taskId, reviewerSessionId), "Review Ledger");

  state.latest_round = Math.max(Number(state.latest_round || 0), round);
  state.latest_prepared_at = nowIso();
  state.rounds[String(round)] = {
    round,
    prepared_at: state.latest_prepared_at,
    repo_head: repoHead,
    worktree_status_sha256: sha256Text(worktreeStatus),
    current_artifact: current.relative,
    current_artifact_sha256: currentSha256,
    previous_artifact: previous?.relative || null,
    previous_artifact_sha256: previousSha256,
    diff_file: diffFile ? path.relative(workdir, diffFile).split(path.sep).join("/") : null,
    diff_sha256: diffSha256,
  };
  writeState(stateFile, state);

  return {
    status: "prepared",
    task_id: taskId,
    reviewer_session_id: reviewerSessionId,
    round,
    repo_head: repoHead,
    repo_head_changed: repoHeadChanged,
    worktree_changed: worktreeChanged,
    current_artifact: current.relative,
    previous_artifact: previous?.relative || null,
    diff_file: diffFile ? path.relative(workdir, diffFile).split(path.sep).join("/") : null,
    diff_empty: diffEmpty,
    evidence_index: path.relative(workdir, evidenceIndex).split(path.sep).join("/"),
    review_ledger: path.relative(workdir, reviewLedger).split(path.sep).join("/"),
    state_file: path.relative(workdir, stateFile).split(path.sep).join("/"),
    stale_evidence_before_recording: beforeRecording,
    stale_evidence: stale,
    recorded_evidence: [...new Set(rawOptions.recordEvidence || [])].sort(),
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: [
      "--workdir", "--task-id", "--reviewer-session-id", "--round",
      "--current-artifact", "--previous-artifact",
    ],
    repeatableValues: ["--record-evidence"],
    flags: ["--json"],
    defaults: { recordEvidence: [], json: false },
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [
    ["workdir", "--workdir"], ["taskId", "--task-id"],
    ["reviewerSessionId", "--reviewer-session-id"], ["round", "--round"],
    ["currentArtifact", "--current-artifact"],
  ]) {
    if (!options[key]) fail(`${label} is required`);
  }
  const summary = prepareIncrementalReview(options, dependencies);
  process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `Prepared design review round ${summary.round}: ${summary.current_artifact}\n`);
}

if (isMain(import.meta.url)) execute(main);
