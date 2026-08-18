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
  readJson,
  requireCommand,
  run,
  stringField,
  writeJsonAtomic
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";
import {
  designSpecDraftRequestedMessage,
  designSpecReviewContextMessage,
  designPruneContextMessage,
  sendDesignSpecDraftRequestedMessage,
  sendDesignSpecReviewContextMessage,
  sendDesignPruneContextMessage
} from "./action-producers.mjs";

const usage = `Initialize one design lane and notify reviewer, optional pruner, then author.

Required:
  --workdir <path>
  --task-id <id>
  --requester-role <role>
  --requester-session-id <id>
  --author-session-id <id>
  --reviewer-session-id <id>
  --session-host <host>
  --round 1
  --max-review-rounds <positive-integer>
  --artifact-path <path>
  --archive-branch <branch>
  --from-address <address>
  --author-to-address <address>
  --reviewer-to-address <address>
  --contract-file <path>

Optional:
  --pruner-policy <auto|always|never>
                                  Default: always with pruner args; auto otherwise
  --pruner-session-id <id>      Enable the pruner; requires --pruner-to-address
  --pruner-to-address <address> Enable the pruner; requires --pruner-session-id
  --artifact-root <path>         Default: <workdir>/.agent-artifacts/design-spec-dispatch
  --content-type <type>          Default: text/markdown
  --schema-version <value>       Default: 1
  --send-timeout-ms <ms>         Default: 0
  --json
  -h, --help

Rerunning the same command is safe. Existing matching state is preserved and
initial notifications are repeated; receivers treat duplicates as no-ops.`;

export const DEFAULT_SEND_TIMEOUT_MS = 0;

function requirePlainHeaderText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    fail(`${label} has an unsafe header value`);
  }
}

function optionalOutputString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function sendOutputFrom(output) {
  const payload = JSON.parse(output);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("waypost send returned a non-object JSON payload");
  }
  const receipt = {};
  for (const key of ["delivery_id", "message_id", "blob_id"]) {
    const value = optionalOutputString(payload[key]);
    if (value) receipt[key] = value;
  }
  const notifyStatus = optionalOutputString(payload.notify_status);
  return {
    receipt,
    notification: {
      status: notifyStatus || "unknown",
      scheme: optionalOutputString(payload.notify_scheme),
      error: optionalOutputString(payload.notify_error)
        || (notifyStatus ? null : "waypost send --notify returned no notify_status")
    }
  };
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value || "")) fail(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value, label) {
  if (!/^\d+$/.test(value || "")) fail(`${label} must be a non-negative integer`);
  return Number(value);
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireSinglePathSegment(value, label) {
  if (value === "." || value === ".." || value.includes("\0") || /[\\/]/.test(value)) {
    fail(`${label} must be one path-safe segment`);
  }
}

function expectedArtifactPath(authorSessionId) {
  return path.posix.join(".agent-artifacts", "design-spec", authorSessionId, "r001.md");
}

export function requireSymlinkFreeContainedPath(root, candidate, label) {
  if (!pathIsInside(root, candidate)) fail(`${label} must be inside --workdir`);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (info.isSymbolicLink()) fail(`${label} must not contain symlink components: ${current}`);
    if (!info.isDirectory()) fail(`${label} has a non-directory path component: ${current}`);
  }
}

export function readContract(contractFile, readFileSync = fs.readFileSync, requireInitialRevision = true) {
  if (!fs.statSync(contractFile, { throwIfNoEntry: false })?.isFile()) {
    fail(`contract file not found: ${contractFile}`);
  }
  const contract = readFileSync(contractFile, "utf8");
  if (!contract.trim()) fail("design task contract is empty");
  const revisionMatch = /^Context Revision: ([1-9]\d*)(?:\r?\n|$)/.exec(contract);
  if (!revisionMatch || (requireInitialRevision && revisionMatch[1] !== "1")) {
    fail(requireInitialRevision
      ? "initial design task contract must start with Context Revision: 1"
      : "design task contract must start with a positive Context Revision");
  }
  return { contract, revision: Number(revisionMatch[1]) };
}

function laneNotification(messageFactory, before, after) {
  return messageFactory({ before, after, body: "" });
}

function reviewerBody(options) {
  return laneNotification(
    designSpecReviewContextMessage,
    [{ name: "Task", value: options.taskId }],
    [
      { name: "Context", value: "initial" },
      { name: "Context Revision", value: String(options.contextRevision) },
      { name: "Lane State", value: options.laneStateFile }
    ]
  );
}

function prunerBody(options) {
  return laneNotification(
    designPruneContextMessage,
    [{ name: "Task", value: options.taskId }],
    [
      { name: "Context", value: "initial" },
      { name: "Context Revision", value: String(options.contextRevision) },
      { name: "Lane State", value: options.laneStateFile }
    ]
  );
}

function authorBody(options) {
  return laneNotification(
    designSpecDraftRequestedMessage,
    [{ name: "Task", value: options.taskId }],
    [
      { name: "Lane State", value: options.laneStateFile },
      { name: "Round", value: "1" }
    ]
  );
}

export function sendWaypost(sendMessage, options, toAddress, subject, message, runCommand = run) {
  const sent = sendMessage(message, {
    toAddress,
    fromAddress: options.fromAddress,
    subject,
    contentType: options.contentType,
    schemaVersion: options.schemaVersion,
    sendTimeoutMs: options.sendTimeoutMs,
    runCommand
  });
  if (sent.timedOut || sent.signal) {
    return { status: "interrupted", signal: sent.signal || "SIGTERM", timedOut: sent.timedOut };
  }
  if (sent.error) return { status: "failed", detail: sent.error.message };
  if (sent.status !== 0) {
    return { status: "failed", detail: (sent.stderr || sent.stdout).trim() || `exit code ${sent.status}` };
  }
  let parsed;
  try {
    parsed = sendOutputFrom(sent.stdout);
  } catch {
    return { status: "receipt_unknown", raw: sent.stdout + sent.stderr };
  }
  return parsed.receipt.delivery_id
    ? { status: "sent", ...parsed }
    : { status: "receipt_unknown", raw: sent.stdout + sent.stderr };
}

export function failDelivery(label, result) {
  if (result.status === "interrupted") fail(`${label} send interrupted; rerun the same command`, 4, "SEND_INTERRUPTED");
  if (result.status === "receipt_unknown") fail(`${label} send result is unclear; rerun the same command`, 5, "SEND_RECEIPT_UNKNOWN");
  fail(`${label} send failed: ${result.detail || "unknown error"}`, 3, "SEND_FAILED");
}

function authorHasProgress(state, options) {
  return state.current_round !== 1
    || state.context_revision !== 1
    || state.review_epoch !== 0
    || state.correctness_epoch !== null
    || state.prune_epoch !== null
    || state.correctness_report !== null
    || state.prune_report !== null
    || state.review_gate != null
    || state.acceptance !== null
    || state.previous_artifact !== null
    || (Array.isArray(state.user_decisions) && state.user_decisions.length > 0)
    || fs.statSync(path.join(options.workdir, expectedArtifactPath(options.authorSessionId)), { throwIfNoEntry: false })?.isFile();
}

function validateExistingState(state, options) {
  if (![2, 3].includes(state?.schema_version)) fail("existing design lane has an unsupported schema");
  for (const [field, expected] of [
    ["task_id", options.taskId],
    ["requester_session_id", options.requesterSessionId],
    ["requester_address", options.fromAddress],
    ["author_session_id", options.authorSessionId],
    ["author_to_address", options.authorToAddress],
    ["reviewer_session_id", options.reviewerSessionId],
    ["reviewer_to_address", options.reviewerToAddress],
    ["session_host", options.sessionHost],
    ["context_file", options.contextFile],
    ["archive_branch", options.archiveBranch]
  ]) {
    if (stringField(state, field) !== expected) fail(`existing design lane has different ${field}`);
  }
  const existingPrunerPolicy = state.schema_version === 2
    ? (state.pruner_session_id || state.pruner_to_address ? "always" : "never")
    : stringField(state, "pruner_policy");
  if ((state.schema_version === 3 || options.prunerPolicyExplicit)
    && existingPrunerPolicy !== options.prunerPolicy) {
    fail("existing design lane has a different pruner_policy");
  }
  if (stringField(state, "pruner_session_id") !== (options.prunerSessionId || "")
    || stringField(state, "pruner_to_address") !== (options.prunerToAddress || "")) {
    fail("existing design lane has a different pruner");
  }
  if (!authorHasProgress(state, options) && state.max_review_rounds !== options.maxReviewRounds) {
    fail("existing design lane has a different max_review_rounds");
  }
  if (authorHasProgress(state, options) && state.dispatch_ready !== true) {
    fail("existing design lane has author progress before dispatch_ready");
  }
}

function initialState(options) {
  return {
    schema_version: 3,
    task_id: options.taskId,
    requester_role: options.requesterRole,
    requester_session_id: options.requesterSessionId,
    requester_address: options.fromAddress,
    author_session_id: options.authorSessionId,
    author_to_address: options.authorToAddress,
    reviewer_session_id: options.reviewerSessionId,
    reviewer_to_address: options.reviewerToAddress,
    pruner_policy: options.prunerPolicy,
    ...(options.prunerSessionId ? {
      pruner_session_id: options.prunerSessionId,
      pruner_to_address: options.prunerToAddress
    } : {}),
    session_host: options.sessionHost,
    context_file: options.contextFile,
    context_revision: 1,
    archive_branch: options.archiveBranch,
    dispatch_ready: false,
    current_round: 1,
    max_review_rounds: options.maxReviewRounds,
    current_artifact: options.artifactPath,
    previous_artifact: null,
    review_epoch: 0,
    correctness_epoch: null,
    prune_epoch: null,
    user_decisions: [],
    correctness_report: null,
    prune_report: null,
    review_gate: null,
    acceptance: null,
    created_at: nowIso()
  };
}

function validateOptions(options) {
  for (const [key, label] of [
    ["taskId", "--task-id"], ["requesterRole", "--requester-role"],
    ["requesterSessionId", "--requester-session-id"], ["authorSessionId", "--author-session-id"],
    ["reviewerSessionId", "--reviewer-session-id"], ["sessionHost", "--session-host"]
  ]) requirePlainHeaderText(options[key], label);
  if (options.prunerSessionId) requirePlainHeaderText(options.prunerSessionId, "--pruner-session-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.taskId)) {
    fail("--task-id must use letters, digits, dot, underscore, or hyphen");
  }
  if (Boolean(options.prunerSessionId) !== Boolean(options.prunerToAddress)) {
    fail("--pruner-session-id and --pruner-to-address must be provided together");
  }
  if (!["auto", "always", "never"].includes(options.prunerPolicy)) {
    fail("--pruner-policy must be auto, always, or never");
  }
  if (options.prunerPolicy === "always" && !options.prunerSessionId) {
    fail("--pruner-policy always requires pruner session and address");
  }
  if (options.prunerPolicy === "never" && options.prunerSessionId) {
    fail("--pruner-policy never cannot include a pruner session");
  }
  if (options.prunerPolicy === "auto" && options.prunerSessionId) {
    fail("--pruner-policy auto must defer pruner creation to review dispatch");
  }
  const ids = [options.requesterSessionId, options.authorSessionId, options.reviewerSessionId];
  if (options.prunerSessionId) ids.push(options.prunerSessionId);
  if (new Set(ids).size !== ids.length) fail("requester, author, reviewer, and pruner session ids must be distinct");
  const addresses = [options.fromAddress, options.authorToAddress, options.reviewerToAddress];
  if (options.prunerToAddress) addresses.push(options.prunerToAddress);
  if (new Set(addresses).size !== addresses.length) fail("requester, author, reviewer, and pruner Waypost addresses must be distinct");
  requireSinglePathSegment(options.authorSessionId, "--author-session-id");
  if (options.prunerSessionId) requireSinglePathSegment(options.prunerSessionId, "--pruner-session-id");
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const runWaypost = dependencies.runWaypost || run;
  const options = parseArgs(argv, {
    values: [
      "--workdir", "--task-id", "--requester-role", "--requester-session-id",
      "--author-session-id", "--reviewer-session-id", "--session-host", "--round",
      "--max-review-rounds", "--artifact-path", "--archive-branch", "--from-address",
      "--author-to-address", "--reviewer-to-address", "--contract-file", "--artifact-root",
      "--pruner-policy", "--pruner-session-id", "--pruner-to-address", "--content-type", "--schema-version",
      "--send-timeout-ms"
    ],
    flags: ["--json"],
    defaults: {
      artifactRoot: "",
      contentType: "text/markdown",
      schemaVersion: "1",
      sendTimeoutMs: String(DEFAULT_SEND_TIMEOUT_MS),
      json: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [key, label] of [
    ["workdir", "--workdir"], ["taskId", "--task-id"],
    ["requesterRole", "--requester-role"], ["requesterSessionId", "--requester-session-id"],
    ["authorSessionId", "--author-session-id"], ["reviewerSessionId", "--reviewer-session-id"],
    ["sessionHost", "--session-host"], ["round", "--round"],
    ["maxReviewRounds", "--max-review-rounds"], ["artifactPath", "--artifact-path"],
    ["archiveBranch", "--archive-branch"], ["fromAddress", "--from-address"],
    ["authorToAddress", "--author-to-address"], ["reviewerToAddress", "--reviewer-to-address"],
    ["contractFile", "--contract-file"]
  ]) if (!options[key]) fail(`${label} is required`);

  options.prunerPolicyExplicit = Boolean(options.prunerPolicy);
  options.prunerPolicy = options.prunerPolicy
    || (options.prunerSessionId || options.prunerToAddress ? "always" : "auto");

  validateOptions(options);
  options.round = positiveInteger(options.round, "--round");
  if (options.round !== 1) fail("--round must be 1 for initial design dispatch");
  options.maxReviewRounds = positiveInteger(options.maxReviewRounds, "--max-review-rounds");
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  if (options.artifactPath !== expectedArtifactPath(options.authorSessionId)) {
    fail(`--artifact-path must equal ${expectedArtifactPath(options.authorSessionId)}`);
  }
  (dependencies.requireCommand || requireCommand)("waypost");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) fail(`workdir does not exist: ${options.workdir}`);

  const requestedWorkdir = path.resolve(options.workdir);
  const requestedArtifactRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : null;
  options.workdir = fs.realpathSync(options.workdir);
  options.contractFile = fs.realpathSync(options.contractFile);
  const contract = readContract(options.contractFile, fs.readFileSync, false);
  options.contextRevision = contract.revision;
  const messageRoot = path.join(options.workdir, ".agent-artifacts", "message");
  if (!pathIsInside(messageRoot, options.contractFile)) fail("--contract-file must be under <workdir>/.agent-artifacts/message/");
  options.contextFile = path.relative(options.workdir, options.contractFile).split(path.sep).join(path.posix.sep);
  if (/[\r\n]/.test(options.contextFile)) fail("--contract-file path must not contain CR or LF");

  if (!options.artifactRoot) {
    options.artifactRoot = path.join(options.workdir, ".agent-artifacts", "design-spec-dispatch");
  } else {
    const relative = path.relative(requestedWorkdir, requestedArtifactRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail("--artifact-root must be inside --workdir");
    }
    options.artifactRoot = path.join(options.workdir, relative);
  }
  options.artifactRoot = path.resolve(options.artifactRoot);
  requireSymlinkFreeContainedPath(options.workdir, options.artifactRoot, "--artifact-root");
  fs.mkdirSync(options.artifactRoot, { recursive: true });
  requireSymlinkFreeContainedPath(options.workdir, options.artifactRoot, "--artifact-root");

  const stateDir = path.join(options.artifactRoot, `${options.taskId}.lock`);
  const stateFile = path.join(stateDir, "state.json");
  options.laneStateFile = path.relative(options.workdir, stateFile).split(path.sep).join(path.posix.sep);
  if (/[\r\n]/.test(options.laneStateFile)) fail("--artifact-root path must not contain CR or LF");
  const existing = fs.lstatSync(stateDir, { throwIfNoEntry: false });
  if (existing) {
    requireSymlinkFreeContainedPath(options.workdir, stateDir, "design dispatch state directory");
    const stateInfo = fs.lstatSync(stateFile, { throwIfNoEntry: false });
    if (!stateInfo?.isFile() || stateInfo.isSymbolicLink()) fail(`unsafe design lane state: ${stateFile}`);
    validateExistingState(readJson(stateFile), options);
  } else {
    if (contract.revision !== 1) fail("a new design lane requires Context Revision: 1");
    fs.mkdirSync(stateDir, { recursive: false });
    try {
      requireSymlinkFreeContainedPath(options.workdir, stateDir, "design dispatch state directory");
      (dependencies.writeJsonAtomic || writeJsonAtomic)(stateFile, initialState(options));
    } catch (error) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      throw error;
    }
  }

  const send = (sender, address, subject, body, label) => {
    const result = sendWaypost(sender, options, address, subject, body, runWaypost);
    if (result.status !== "sent") failDelivery(label, result);
    return result;
  };

  send(
    sendDesignSpecReviewContextMessage,
    options.reviewerToAddress,
    `design-spec context: ${options.taskId} -> reviewer`,
    reviewerBody(options),
    "reviewer context"
  );
  if (options.prunerSessionId) {
    send(
      sendDesignPruneContextMessage,
      options.prunerToAddress,
      `design-spec context: ${options.taskId} -> pruner`,
      prunerBody(options),
      "pruner context"
    );
  }

  const stateBeforeAuthor = readJson(stateFile);
  if (stateBeforeAuthor.dispatch_ready !== true) {
    if (authorHasProgress(stateBeforeAuthor, options)) fail("cannot finalize context dispatch after author progress");
    stateBeforeAuthor.dispatch_ready = true;
    writeJsonAtomic(stateFile, stateBeforeAuthor);
  }

  send(
    sendDesignSpecDraftRequestedMessage,
    options.authorToAddress,
    `design-spec draft: ${options.taskId} r1`,
    authorBody(options),
    "author draft"
  );

  const summary = {
    status: "sent",
    state_file: stateFile
  };
  process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `Design draft dispatched: ${options.taskId}\n`);
}

if (isMain(import.meta.url)) execute(main);
