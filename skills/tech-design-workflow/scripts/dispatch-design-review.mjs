#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  execute,
  fail,
  isMain,
  parseArgs,
  readJson,
  requireCommand,
  writeJsonAtomic
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";
import {
  designPruneRequestedMessage,
  designSpecReviewRequestedMessage,
  sendDesignPruneRequestedMessage,
  sendDesignSpecReviewRequestedMessage
} from "./action-producers.mjs";
import {
  failDelivery,
  requireSymlinkFreeContainedPath,
  sendWaypost
} from "./send-design-draft-with-review-context.mjs";
import { loadWorkflowPolicy } from "./workflow-policy.mjs";

const usage = `Gate and dispatch one immutable design artifact for review.

Required:
  --workdir <path>
  --lane-state <workspace-relative-path>

Optional:
  --pruner-session-id <id>      Activate a required lazy pruner
  --pruner-to-address <address> Activate a required lazy pruner
  --new-epoch                   Request a fresh review of the same authority
  --verify-gate                 Verify current bytes against the stored review gate
  --content-type <type>         Default: text/markdown
  --schema-version <value>      Default: 1
  --send-timeout-ms <ms>        Default: 0
  --json
  -h, --help

Dispatch mode writes the review gate and epoch before sending. Rerunning without
--new-epoch reuses that epoch only when the artifact bytes still match.
--verify-gate performs a read-only digest check and does not require Waypost.`;

function plain(value, label) {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) fail(`${label} has an unsafe value`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!/^\d+$/.test(value || "")) fail(`${label} must be a non-negative integer`);
  return Number(value);
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRegularFile(filePath, label) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${label} is not a safe regular file: ${filePath}`);
}

export function measureDesign(source) {
  return {
    lines: source.split(/\r?\n/).filter(line => line.trim()).length,
    chars: [...source.replace(/\s/gu, "")].length
  };
}

export function artifactSha256(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function reviewMessage(factory, state, laneStateFile, epoch) {
  return factory({
    before: [{ name: "Task", value: state.task_id }],
    after: [
      { name: "Lane State", value: laneStateFile },
      { name: "Review Epoch", value: String(epoch) },
      { name: "Round", value: String(state.current_round) }
    ],
    body: ""
  });
}

function gateMatches(state, gate) {
  const prior = state.review_gate;
  return prior
    && prior.round === gate.round
    && prior.artifact === gate.artifact
    && prior.context_revision === gate.context_revision
    && prior.user_decision_count === gate.user_decision_count
    && prior.lines === gate.lines
    && prior.chars === gate.chars
    && prior.artifact_sha256 === gate.artifact_sha256
    && prior.max_lines === gate.max_lines
    && prior.max_chars === gate.max_chars
    && prior.pruner_required === gate.pruner_required;
}

function rejectChangedGatedArtifact(state, digest) {
  const prior = state.review_gate;
  if (!prior || prior.round !== state.current_round || prior.artifact !== state.current_artifact) return;
  if (!/^[0-9a-f]{64}$/.test(prior.artifact_sha256 || "")) {
    fail("current review gate has an invalid artifact digest", 3, "REVIEW_GATE_INVALID");
  }
  if (prior.artifact_sha256 !== digest) {
    fail(
      "current artifact bytes differ from the dispatched review gate; create a replacement snapshot",
      3,
      "ARTIFACT_CHANGED"
    );
  }
}

function validateState(state) {
  if (![2, 3].includes(state?.schema_version)) fail("design lane has an unsupported schema");
  for (const field of [
    "task_id", "author_session_id", "author_to_address", "reviewer_session_id",
    "reviewer_to_address", "current_artifact"
  ]) plain(state[field], `lane state ${field}`);
  if (!Number.isInteger(state.current_round) || state.current_round <= 0) fail("lane state current_round is invalid");
  if (!Number.isInteger(state.review_epoch) || state.review_epoch < 0) fail("lane state review_epoch is invalid");
  if (!Array.isArray(state.user_decisions)) fail("lane state user_decisions is invalid");
  if (state.schema_version === 3 && !["auto", "always", "never"].includes(state.pruner_policy)) {
    fail("lane state pruner_policy is invalid");
  }
  if (Boolean(state.pruner_session_id) !== Boolean(state.pruner_to_address)) {
    fail("lane state has an incomplete pruner identity");
  }
}

function migrateSchemaV2ForReview(state, verifyOnly) {
  if (state.schema_version !== 2) return;
  if (verifyOnly) {
    fail(
      "schema-v2 lane has no digest-bound review gate; run normal review dispatch to migrate and re-review",
      3,
      "REVIEW_GATE_INVALID"
    );
  }
  state.schema_version = 3;
  state.pruner_policy = state.pruner_session_id ? "always" : "never";
  state.review_gate = null;
}

function validatePrunerActivation(state, options, required) {
  const provided = Boolean(options.prunerSessionId || options.prunerToAddress);
  if (Boolean(options.prunerSessionId) !== Boolean(options.prunerToAddress)) {
    fail("--pruner-session-id and --pruner-to-address must be provided together");
  }
  const existing = Boolean(state.pruner_session_id || state.pruner_to_address);
  if (Boolean(state.pruner_session_id) !== Boolean(state.pruner_to_address)) fail("lane state has an incomplete pruner identity");
  if (provided) {
    plain(options.prunerSessionId, "--pruner-session-id");
    plain(options.prunerToAddress, "--pruner-to-address");
    if (state.pruner_policy === "never") fail("the lane explicitly disables pruning");
    if (!required && state.pruner_policy !== "always") fail("the design does not require lazy pruner activation");
    if (existing && (state.pruner_session_id !== options.prunerSessionId
      || state.pruner_to_address !== options.prunerToAddress)) {
      fail("lane state already records a different pruner");
    }
    const ids = [state.requester_session_id, state.author_session_id, state.reviewer_session_id];
    const addresses = [state.requester_address, state.author_to_address, state.reviewer_to_address];
    if (ids.includes(options.prunerSessionId)) fail("pruner session id must be distinct");
    if (addresses.includes(options.prunerToAddress)) fail("pruner address must be distinct");
    state.pruner_session_id = options.prunerSessionId;
    state.pruner_to_address = options.prunerToAddress;
    return true;
  }
  return existing;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: [
      "--workdir", "--lane-state", "--pruner-session-id", "--pruner-to-address",
      "--content-type", "--schema-version", "--send-timeout-ms"
    ],
    flags: ["--new-epoch", "--verify-gate", "--json"],
    defaults: {
      contentType: "text/markdown",
      schemaVersion: "1",
      sendTimeoutMs: "0",
      newEpoch: false,
      json: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.workdir) fail("--workdir is required");
  if (!options.laneState) fail("--lane-state is required");
  if (options.verifyGate && (options.newEpoch || options.prunerSessionId || options.prunerToAddress)) {
    fail("--verify-gate cannot be combined with review-dispatch options");
  }
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  if (!options.verifyGate) (dependencies.requireCommand || requireCommand)("waypost");

  const requestedWorkdir = path.resolve(options.workdir);
  if (!fs.statSync(requestedWorkdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${requestedWorkdir}`);
  const workdir = fs.realpathSync(requestedWorkdir);
  if (path.isAbsolute(options.laneState)) fail("--lane-state must be workspace-relative");
  const stateFile = path.resolve(workdir, options.laneState);
  if (!pathInside(workdir, stateFile)) fail("--lane-state must be inside --workdir");
  requireSymlinkFreeContainedPath(workdir, path.dirname(stateFile), "lane state parent");
  safeRegularFile(stateFile, "lane state");
  const laneStateFile = path.relative(workdir, stateFile).split(path.sep).join(path.posix.sep);
  const state = readJson(stateFile);
  validateState(state);
  migrateSchemaV2ForReview(state, options.verifyGate);
  if (state.dispatch_ready !== true) fail("design lane context dispatch is not ready");

  if (path.isAbsolute(state.current_artifact)) fail("lane state current_artifact must be workspace-relative");
  const artifactFile = path.resolve(workdir, state.current_artifact);
  if (!pathInside(workdir, artifactFile)) fail("current artifact escapes --workdir");
  const expectedArtifact = path.posix.join(
    ".agent-artifacts", "design-spec", state.author_session_id,
    `r${String(state.current_round).padStart(3, "0")}.md`
  );
  if (state.current_artifact !== expectedArtifact) fail(`current artifact must equal ${expectedArtifact}`);
  requireSymlinkFreeContainedPath(workdir, path.dirname(artifactFile), "current artifact parent");
  safeRegularFile(artifactFile, "current artifact");
  const artifactBytes = fs.readFileSync(artifactFile);
  const metrics = measureDesign(artifactBytes.toString("utf8"));
  const digest = artifactSha256(artifactBytes);
  rejectChangedGatedArtifact(state, digest);
  if (options.verifyGate) {
    const gate = state.review_gate;
    if (!gate || gate.round !== state.current_round || gate.artifact !== state.current_artifact
      || gate.context_revision !== state.context_revision
      || gate.user_decision_count !== state.user_decisions.length) {
      fail("current review gate is missing or does not match lane authority", 3, "REVIEW_GATE_INVALID");
    }
    const summary = { status: "verified", artifact: state.current_artifact, artifact_sha256: digest };
    process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `Design review gate verified: ${state.task_id} r${state.current_round}\n`);
    return;
  }
  const policy = (dependencies.loadPolicy || loadWorkflowPolicy)({
    cwd: workdir,
    env: dependencies.env || process.env,
    homeDir: dependencies.homeDir
  });
  const exceedsSize = metrics.lines >= policy.maxLines || metrics.chars >= policy.maxChars;
  const prunerRequired = state.pruner_policy === "always"
    || (state.pruner_policy === "auto" && exceedsSize);
  const hasPruner = validatePrunerActivation(state, options, prunerRequired);
  if (prunerRequired && !hasPruner) {
    fail(
      `design has ${metrics.lines} nonempty lines and ${metrics.chars} non-whitespace characters; `
      + `activate a design_pruner and rerun this dispatch`,
      3,
      "PRUNER_REQUIRED"
    );
  }

  const gate = {
    round: state.current_round,
    artifact: state.current_artifact,
    context_revision: state.context_revision,
    user_decision_count: state.user_decisions.length,
    lines: metrics.lines,
    chars: metrics.chars,
    artifact_sha256: digest,
    max_lines: policy.maxLines,
    max_chars: policy.maxChars,
    pruner_required: hasPruner
  };
  const reuseEpoch = !options.newEpoch
    && gateMatches(state, gate)
    && state.correctness_epoch === state.review_epoch
    && (!hasPruner || state.prune_epoch === state.review_epoch);
  if (!reuseEpoch) {
    state.review_epoch += 1;
    state.correctness_epoch = state.review_epoch;
    state.prune_epoch = hasPruner ? state.review_epoch : null;
    state.correctness_report = null;
    state.prune_report = null;
    state.acceptance = null;
    state.review_gate = gate;
    (dependencies.writeJsonAtomic || writeJsonAtomic)(stateFile, state);
  }
  const epoch = state.review_epoch;
  const sendOptions = {
    fromAddress: state.author_to_address,
    contentType: options.contentType,
    schemaVersion: options.schemaVersion,
    sendTimeoutMs: options.sendTimeoutMs
  };
  const runWaypost = dependencies.runWaypost;
  const send = (sender, address, subject, body, label) => {
    const result = sendWaypost(sender, sendOptions, address, subject, body, runWaypost);
    if (result.status !== "sent") failDelivery(label, result);
  };
  send(
    sendDesignSpecReviewRequestedMessage,
    state.reviewer_to_address,
    `design-spec review: ${state.task_id} r${state.current_round}`,
    reviewMessage(designSpecReviewRequestedMessage, state, laneStateFile, epoch),
    "design review"
  );
  if (hasPruner) {
    send(
      sendDesignPruneRequestedMessage,
      state.pruner_to_address,
      `design prune: ${state.task_id} r${state.current_round}`,
      reviewMessage(designPruneRequestedMessage, state, laneStateFile, epoch),
      "design prune"
    );
  }
  const summary = { status: "sent", review_epoch: epoch, review_gate: gate };
  process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `Design review dispatched: ${state.task_id} r${state.current_round}\n`);
}

if (isMain(import.meta.url)) execute(main);
