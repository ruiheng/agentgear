#!/usr/bin/env node
import crypto from "node:crypto";
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
  sendDesignSpecDraftRequestedMessage,
  sendDesignSpecReviewContextMessage
} from "./action-producers.mjs";

const usage = `Send one canonical design task contract to reviewer first, then author.

Required:
  --workdir <path>
  --task-id <id>
  --requester-role <role>
  --requester-session-id <id>
  --author-session-id <id>
  --reviewer-session-id <id>
  --session-host <host>
  --round <positive-integer>
  --max-review-rounds <positive-integer>
  --artifact-path <path>
  --archive-branch <branch>
  --from-address <address>
  --author-to-address <address>
  --reviewer-to-address <address>
  --contract-file <path>

Optional:
  --artifact-root <path>         Default: <workdir>/.agent-artifacts/design-spec-dispatch
  --content-type <type>          Default: text/markdown
  --schema-version <value>       Default: 1
  --send-timeout-ms <ms>         Default: 0 (disabled; diagnostic override)
  --json
  -h, --help`;

export const DEFAULT_SEND_TIMEOUT_MS = 0;

function requirePlainHeaderText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    fail(`${label} has an unsafe header value`);
  }
}

function validateEnvelopeOptions(options) {
  for (const [key, label] of [
    ["taskId", "--task-id"],
    ["requesterRole", "--requester-role"],
    ["requesterSessionId", "--requester-session-id"],
    ["authorSessionId", "--author-session-id"],
    ["reviewerSessionId", "--reviewer-session-id"],
    ["sessionHost", "--session-host"]
  ]) requirePlainHeaderText(options[key], label);
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

function expectedArtifactPath(authorSessionId, round) {
  return path.posix.join(
    ".agent-artifacts",
    "design-spec",
    authorSessionId,
    `r${String(round).padStart(3, "0")}.md`
  );
}

function requireSymlinkFreeContainedPath(root, candidate, label) {
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

export function readContract(contractFile, readFileSync = fs.readFileSync) {
  if (!fs.statSync(contractFile, { throwIfNoEntry: false })?.isFile()) {
    fail(`contract file not found: ${contractFile}`);
  }
  const contract = readFileSync(contractFile, "utf8");
  if (!contract.trim()) fail("design task contract is empty");
  return contract;
}

function messageWithContract(messageFactory, before, after, contract, footer) {
  const terminator = contract.endsWith("\n") ? "" : "\n";
  return messageFactory({
    before,
    after,
    body: `# Design Task Contract\n${contract}${terminator}\n${footer}`
  });
}

function reviewerBody(options, contract) {
  const before = [{ name: "Task", value: options.taskId }];
  const after = [
    { name: "Context", value: "initial" },
    { name: "From", value: `${options.requesterRole} ${options.requesterSessionId}` },
    { name: "To", value: `architect_reviewer ${options.reviewerSessionId}` },
    { name: "Author", value: `architect_author ${options.authorSessionId}` },
    { name: "Session Host", value: options.sessionHost },
    { name: "Round", value: "context" },
    { name: "Max Review Rounds", value: String(options.maxReviewRounds) }
  ];
  const footer = `# Review Context Contract
- Treat the requester Design Task Contract as original-task authority
- Retain it as task-scoped design-review context and wait for the matching \`design_spec_review_requested\`
- Do not inspect or judge a design from this context message alone
- Before opening the review target, reconstruct the goal, constraints, explicit non-goals, and smallest acceptable change from this contract
`;
  return messageWithContract(designSpecReviewContextMessage, before, after, contract, footer);
}

function authorBody(options, contract) {
  const before = [{ name: "Task", value: options.taskId }];
  const after = [
    { name: "From", value: `${options.requesterRole} ${options.requesterSessionId}` },
    { name: "To", value: `architect_author ${options.authorSessionId}` },
    { name: "Reviewer", value: `architect_reviewer ${options.reviewerSessionId}` },
    { name: "Session Host", value: options.sessionHost },
    { name: "Round", value: String(options.round) },
    { name: "Max Review Rounds", value: String(options.maxReviewRounds) }
  ];
  const footer = `# Draft Contract
## Artifact
- Target: ${options.artifactPath}

## Archive Target
- Branch: ${options.archiveBranch}

## Rules
- Treat the requester Design Task Contract as original-task authority
- Draft the smallest complete design that satisfies it
- Do not restate task content in the later review request; the reviewer already has this contract
`;
  return messageWithContract(designSpecDraftRequestedMessage, before, after, contract, footer);
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

function mutateState(stateFile, mutate) {
  const state = readJson(stateFile);
  mutate(state);
  writeJsonAtomic(stateFile, state);
}

function recordNotification(state, prefix, notification) {
  state[`${prefix}_notify_status`] = notification.status;
  state[`${prefix}_notify_scheme`] = notification.scheme;
  state[`${prefix}_notify_error`] = notification.error;
}

function rollbackPendingState(stateFile, stateDir, taskId) {
  let state;
  try {
    state = readJson(stateFile);
  } catch {
    return;
  }
  if (stringField(state, "task_id") === taskId && stringField(state, "state") === "pending_reviewer") {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const requireWaypost = dependencies.requireCommand || requireCommand;
  const runWaypost = dependencies.runWaypost || run;
  const writeInitialState = dependencies.writeJsonAtomic || writeJsonAtomic;
  const options = parseArgs(argv, {
    values: [
      "--workdir", "--task-id", "--requester-role", "--requester-session-id",
      "--author-session-id", "--reviewer-session-id", "--session-host", "--round",
      "--max-review-rounds", "--artifact-path", "--archive-branch", "--from-address",
      "--author-to-address", "--reviewer-to-address", "--contract-file", "--artifact-root",
      "--content-type", "--schema-version", "--send-timeout-ms"
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
  ]) {
    if (!options[key]) fail(`${label} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.taskId)) {
    fail("--task-id must use letters, digits, dot, underscore, or hyphen");
  }
  validateEnvelopeOptions(options);
  if (options.authorSessionId === options.reviewerSessionId) {
    fail("author and reviewer session ids must be distinct");
  }
  requireSinglePathSegment(options.authorSessionId, "--author-session-id");
  options.round = positiveInteger(options.round, "--round");
  options.maxReviewRounds = positiveInteger(options.maxReviewRounds, "--max-review-rounds");
  if (options.round > options.maxReviewRounds) fail("--round must not exceed --max-review-rounds");
  if (options.round > 999) fail("--round must be at most 999 for an rNNN artifact path");
  const requiredArtifactPath = expectedArtifactPath(options.authorSessionId, options.round);
  if (options.artifactPath !== requiredArtifactPath) {
    fail(`--artifact-path must equal ${requiredArtifactPath}`);
  }
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  requireWaypost("waypost");
  if (!fs.statSync(options.workdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${options.workdir}`);
  }
  const requestedWorkdir = path.resolve(options.workdir);
  const requestedArtifactRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : null;
  options.workdir = fs.realpathSync(options.workdir);
  const contract = readContract(options.contractFile);
  options.contractFile = fs.realpathSync(options.contractFile);
  const messageRoot = path.join(options.workdir, ".agent-artifacts", "message");
  if (!pathIsInside(messageRoot, options.contractFile)) {
    fail("--contract-file must be under <workdir>/.agent-artifacts/message/");
  }
  if (!options.artifactRoot) {
    options.artifactRoot = path.join(options.workdir, ".agent-artifacts", "design-spec-dispatch");
  } else {
    const relativeArtifactRoot = path.relative(requestedWorkdir, requestedArtifactRoot);
    if (relativeArtifactRoot === ".." || relativeArtifactRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeArtifactRoot)) {
      fail("--artifact-root must be inside --workdir");
    }
    options.artifactRoot = path.join(options.workdir, relativeArtifactRoot);
  }
  options.artifactRoot = path.resolve(options.artifactRoot);
  requireSymlinkFreeContainedPath(options.workdir, options.artifactRoot, "--artifact-root");
  fs.mkdirSync(options.artifactRoot, { recursive: true });
  requireSymlinkFreeContainedPath(options.workdir, options.artifactRoot, "--artifact-root");
  const stateDir = path.join(options.artifactRoot, `${options.taskId}.lock`);
  const stateFile = path.join(stateDir, "state.json");
  if (fs.lstatSync(stateDir, { throwIfNoEntry: false })) {
    fail(`design dispatch state already exists: ${stateFile}; inspect it before any retry`);
  }
  fs.mkdirSync(stateDir, { recursive: false });
  const reviewerSubject = `design-spec context: ${options.taskId} -> reviewer`;
  const authorSubject = `design-spec draft: ${options.taskId} r${options.round}`;
  try {
    requireSymlinkFreeContainedPath(options.workdir, stateDir, "design dispatch state directory");
    writeInitialState(stateFile, {
      schema_version: 1,
      task_id: options.taskId,
      state: "pending_reviewer",
      created_at: nowIso(),
      requester_role: options.requesterRole,
      requester_session_id: options.requesterSessionId,
      author_session_id: options.authorSessionId,
      reviewer_session_id: options.reviewerSessionId,
      session_host: options.sessionHost,
      round: options.round,
      max_review_rounds: options.maxReviewRounds,
      contract_file: options.contractFile,
      contract_sha256: crypto.createHash("sha256").update(contract).digest("hex"),
      reviewer_to_address: options.reviewerToAddress,
      reviewer_subject: reviewerSubject,
      author_to_address: options.authorToAddress,
      author_subject: authorSubject
    });
  } catch (error) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }

  let rollback = true;
  const retainInterrupted = (stage, result) => {
    rollback = false;
    mutateState(stateFile, state => {
      state.state = "send_interrupted_unknown";
      state.send_stage = stage;
      state.interruption_kind = result.timedOut ? "timeout" : "signal";
      state.interrupted_by_signal = result.signal;
      state.interrupted_at = nowIso();
      state.send_timeout_ms = options.sendTimeoutMs;
    });
  };
  const retainUnknownReceipt = (stage, raw) => {
    rollback = false;
    mutateState(stateFile, state => {
      state.state = "queued_receipt_unknown";
      state.send_stage = stage;
      state.queued_at = nowIso();
      state.send_receipt_raw = raw;
    });
  };

  try {
    process.stderr.write("sending reviewer...\n");
    const reviewerSent = sendWaypost(sendDesignSpecReviewContextMessage, options, options.reviewerToAddress, reviewerSubject, reviewerBody(options, contract), runWaypost);
    if (reviewerSent.status === "interrupted") {
      retainInterrupted("reviewer", reviewerSent);
      fail("reviewer context send interrupted; delivery is unknown", 4, "SEND_INTERRUPTED");
    }
    if (reviewerSent.status === "failed") {
      fail(`reviewer context send failed: ${reviewerSent.detail}`, 3, "SEND_FAILED");
    }
    if (reviewerSent.status === "receipt_unknown") {
      retainUnknownReceipt("reviewer", reviewerSent.raw);
      fail("reviewer context sent without a delivery id; inspect Waypost before retry", 5, "SEND_RECEIPT_UNKNOWN");
    }
    rollback = false;
    mutateState(stateFile, state => {
      state.state = "review_context_sent";
      state.review_context_delivery_id = reviewerSent.receipt.delivery_id;
      state.review_context_message_id = reviewerSent.receipt.message_id || null;
      state.review_context_sent_at = nowIso();
      recordNotification(state, "review_context", reviewerSent.notification);
    });

    process.stderr.write("sending author...\n");
    const authorSent = sendWaypost(sendDesignSpecDraftRequestedMessage, options, options.authorToAddress, authorSubject, authorBody(options, contract), runWaypost);
    if (authorSent.status === "interrupted") {
      retainInterrupted("author", authorSent);
      fail("author draft send interrupted; delivery is unknown", 4, "SEND_INTERRUPTED");
    }
    if (authorSent.status === "failed") {
      mutateState(stateFile, state => {
        state.state = "author_send_failed";
        state.author_send_failed_at = nowIso();
        state.author_send_error = authorSent.detail;
      });
      fail("reviewer context was delivered but author send failed; dispatch state retained", 3, "SEND_FAILED");
    }
    if (authorSent.status === "receipt_unknown") {
      retainUnknownReceipt("author", authorSent.raw);
      fail("author draft message sent without a delivery id; inspect Waypost before retry", 5, "SEND_RECEIPT_UNKNOWN");
    }
    mutateState(stateFile, state => {
      state.state = "sent";
      state.author_delivery_id = authorSent.receipt.delivery_id;
      state.author_message_id = authorSent.receipt.message_id || null;
      state.sent_at = nowIso();
      recordNotification(state, "author", authorSent.notification);
    });

    const finalState = readJson(stateFile);
    const summary = {
      status: finalState.state,
      review_context_delivery_id: finalState.review_context_delivery_id,
      review_context_notify_status: finalState.review_context_notify_status,
      review_context_notify_scheme: finalState.review_context_notify_scheme,
      review_context_notify_error: finalState.review_context_notify_error,
      author_delivery_id: finalState.author_delivery_id,
      author_notify_status: finalState.author_notify_status,
      author_notify_scheme: finalState.author_notify_scheme,
      author_notify_error: finalState.author_notify_error,
      state_file: stateFile
    };
    process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : `Design draft dispatched: ${options.taskId}\n`);
  } finally {
    if (rollback) rollbackPendingState(stateFile, stateDir, options.taskId);
  }
}

if (isMain(import.meta.url)) execute(main);
