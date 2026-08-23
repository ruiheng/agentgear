#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { sessionNudgeSpec } from "../../../providers/session-hosts.mjs";
import {
  execute,
  fail,
  isMain,
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

const usage = `Create one stable design lane manifest and notify its participants.

Required:
  --workdir <path>
  --task-id <id>
  --requester-session-id <id>
  --author-session-id <id>
  --reviewer-session-id <id>
  --session-host <host>
  --review-checkpoint <positive-integer>
  --archive-branch <branch>
  --from-address <address>
  --author-to-address <address>
  --reviewer-to-address <address>
  --contract-file <path>

Optional:
  --pruner-policy <auto|always|never>
                                  Default: always with pruner args; auto otherwise
  --review-checkpoint-interval <positive-integer>  Default: 2
  --pruner-session-id <id>      Enable the pruner; requires --pruner-to-address
  --pruner-to-address <address> Enable the pruner; requires --pruner-session-id
  --artifact-root <path>         Default: <workdir>/.agent-artifacts/design-spec-dispatch
  --content-type <type>          Default: text/markdown
  --schema-version <value>       Default: 1
  --send-timeout-ms <ms>         Default: 0
  --json
  -h, --help

Each invocation sends new durable participant requests. If Waypost reports that
its best-effort nudge failed, is unknown, or was not attempted for a temporarily
unready target, this invocation retries only the fixed session-host wake notice
unless the delivery is already leased or acknowledged. Failure to inspect
delivery state does not block that one replay.`;

export const DEFAULT_SEND_TIMEOUT_MS = 0;
export const DELIVERY_STATE_TIMEOUT_MS = 5000;
export const NUDGE_MESSAGE = "NOTICE: There might be new message in waypost.";

const NO_NUDGE_REPLAY_STATUSES = new Set([
  "sent",
  "skipped_already_claimed",
  "skipped_disabled",
  "skipped_local"
]);

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

export function expectedArtifactPath(authorSessionId, round = 1) {
  return path.posix.join(
    ".agent-artifacts", "design-spec", authorSessionId,
    `r${String(round).padStart(3, "0")}.md`
  );
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
      { name: "Lane Manifest", value: options.laneManifestFile }
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
      { name: "Lane Manifest", value: options.laneManifestFile }
    ]
  );
}

function authorBody(options) {
  return laneNotification(
    designSpecDraftRequestedMessage,
    [{ name: "Task", value: options.taskId }],
    [
      { name: "Lane Manifest", value: options.laneManifestFile },
      { name: "Artifact", value: expectedArtifactPath(options.authorSessionId) },
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
  if (result.status === "interrupted") {
    fail(`${label} send interrupted; delivery is unknown, inspect Waypost before retrying`, 4, "SEND_INTERRUPTED");
  }
  if (result.status === "receipt_unknown") {
    fail(`${label} send result is unclear; inspect Waypost before retrying`, 5, "SEND_RECEIPT_UNKNOWN");
  }
  fail(`${label} send failed: ${result.detail || "unknown error"}`, 3, "SEND_FAILED");
}

function deliveryState(deliveryId, runCommand) {
  const result = runCommand(
    "waypost",
    ["read", "--delivery", deliveryId, "--json"],
    { timeoutMs: DELIVERY_STATE_TIMEOUT_MS }
  );
  if (result.timedOut || result.signal || result.error || result.status !== 0) {
    return {
      status: "unknown",
      error: result.timedOut
        ? `delivery state read timed out after ${DELIVERY_STATE_TIMEOUT_MS}ms`
        : result.signal
          ? `delivery state read terminated by ${result.signal}`
          : result.error?.message || (result.stderr || result.stdout).trim() || `exit code ${result.status}`
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    const item = Array.isArray(payload?.items)
      ? payload.items.find(candidate => candidate?.delivery_id === deliveryId)
      : null;
    return typeof item?.state === "string" && item.state
      ? { status: item.state, error: null }
      : { status: "unknown", error: "waypost read returned no matching delivery state" };
  } catch {
    return { status: "unknown", error: "waypost read returned invalid JSON" };
  }
}

function sendNudge(sessionHost, sessionId, runCommand) {
  let spec;
  try {
    spec = sessionNudgeSpec({ host: sessionHost, sessionId, message: NUDGE_MESSAGE });
  } catch (error) {
    return { status: "failed", scheme: sessionHost, error: error.message };
  }
  const result = runCommand(spec.command, spec.args, { timeoutMs: spec.timeoutMs });
  if (result.timedOut || result.signal || result.error || result.status !== 0) {
    return {
      status: "failed",
      scheme: sessionHost,
      error: result.timedOut
        ? `nudge timed out after ${spec.timeoutMs}ms`
        : result.signal
          ? `nudge terminated by ${result.signal}`
          : result.error?.message || (result.stderr || result.stdout).trim() || `exit code ${result.status}`
    };
  }
  return { status: "sent", scheme: sessionHost, error: null };
}

function retryNudge(result, sessionHost, sessionId, readDeliveryCommand, runNudgeCommand) {
  if (NO_NUDGE_REPLAY_STATUSES.has(result.notification.status)) {
    return { ...result, nudgeRetryCount: 0, nudgeDeliveryState: null };
  }
  const current = deliveryState(result.receipt.delivery_id, readDeliveryCommand);
  let notification;
  let attempted = false;
  if (["leased", "acked"].includes(current.status)) {
    notification = { status: "skipped_already_claimed", scheme: "waypost", error: null };
  } else {
    notification = sendNudge(sessionHost, sessionId, runNudgeCommand);
    attempted = true;
  }
  return {
    ...result,
    notification,
    nudgeRetryCount: attempted ? 1 : 0,
    nudgeDeliveryState: current.status
  };
}

export function sendWaypostWithNudgeRetry({
  label,
  sessionHost,
  sessionId,
  sender,
  sendOptions,
  toAddress,
  subject,
  message,
  runCommand = run,
  readDeliveryCommand = run,
  runNudgeCommand = run
}) {
  const sent = sendWaypost(sender, sendOptions, toAddress, subject, message, runCommand);
  if (sent.status !== "sent") failDelivery(label, sent);
  return retryNudge(sent, sessionHost, sessionId, readDeliveryCommand, runNudgeCommand);
}

export function stageSummary(prefix, result) {
  return {
    [`${prefix}_delivery_id`]: result?.receipt.delivery_id || null,
    [`${prefix}_notify_status`]: result?.notification.status || null,
    [`${prefix}_notify_scheme`]: result?.notification.scheme || null,
    [`${prefix}_notify_error`]: result?.notification.error || null,
    [`${prefix}_nudge_retry_count`]: result?.nudgeRetryCount || 0,
    [`${prefix}_nudge_delivery_state`]: result?.nudgeDeliveryState || null
  };
}

function validateExistingManifest(manifest, options) {
  if (manifest?.schema_version !== 2) fail("existing design lane manifest must use schema 2");
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
    ["archive_branch", options.archiveBranch],
    ["pruner_policy", options.prunerPolicy]
  ]) {
    if (stringField(manifest, field) !== expected) fail(`existing design lane manifest has different ${field}`);
  }
  if (stringField(manifest, "pruner_session_id") !== (options.prunerSessionId || "")
    || stringField(manifest, "pruner_to_address") !== (options.prunerToAddress || "")) {
    fail("existing design lane manifest has a different initial pruner");
  }
  if (!Number.isInteger(manifest.review_checkpoint)
    || manifest.review_checkpoint < options.reviewCheckpoint) {
    fail("existing design lane manifest has an invalid initial review_checkpoint");
  }
  if (manifest.review_checkpoint_interval !== options.reviewCheckpointInterval) {
    fail("existing design lane manifest has a different review_checkpoint_interval");
  }
}

function initialManifest(options) {
  return {
    schema_version: 2,
    task_id: options.taskId,
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
    archive_branch: options.archiveBranch,
    review_checkpoint: options.reviewCheckpoint,
    review_checkpoint_interval: options.reviewCheckpointInterval
  };
}

function validateOptions(options) {
  for (const [key, label] of [
    ["taskId", "--task-id"],
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
      "--workdir", "--task-id", "--requester-session-id",
      "--author-session-id", "--reviewer-session-id", "--session-host",
      "--review-checkpoint", "--review-checkpoint-interval", "--archive-branch", "--from-address",
      "--author-to-address", "--reviewer-to-address", "--contract-file", "--artifact-root",
      "--pruner-policy", "--pruner-session-id", "--pruner-to-address", "--content-type", "--schema-version",
      "--send-timeout-ms"
    ],
    flags: ["--json"],
    defaults: {
      artifactRoot: "",
      contentType: "text/markdown",
      schemaVersion: "1",
      reviewCheckpointInterval: "2",
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
    ["requesterSessionId", "--requester-session-id"],
    ["authorSessionId", "--author-session-id"], ["reviewerSessionId", "--reviewer-session-id"],
    ["sessionHost", "--session-host"], ["reviewCheckpoint", "--review-checkpoint"],
    ["archiveBranch", "--archive-branch"], ["fromAddress", "--from-address"],
    ["authorToAddress", "--author-to-address"], ["reviewerToAddress", "--reviewer-to-address"],
    ["contractFile", "--contract-file"]
  ]) if (!options[key]) fail(`${label} is required`);

  options.prunerPolicy = options.prunerPolicy
    || (options.prunerSessionId || options.prunerToAddress ? "always" : "auto");

  validateOptions(options);
  options.reviewCheckpoint = positiveInteger(options.reviewCheckpoint, "--review-checkpoint");
  options.reviewCheckpointInterval = positiveInteger(
    options.reviewCheckpointInterval,
    "--review-checkpoint-interval"
  );
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
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

  const laneDir = path.join(options.artifactRoot, `${options.taskId}.lock`);
  const manifestFile = path.join(laneDir, "lane.json");
  options.laneManifestFile = path.relative(options.workdir, manifestFile).split(path.sep).join(path.posix.sep);
  if (/[\r\n]/.test(options.laneManifestFile)) fail("--artifact-root path must not contain CR or LF");
  const existing = fs.lstatSync(laneDir, { throwIfNoEntry: false });
  if (existing) {
    requireSymlinkFreeContainedPath(options.workdir, laneDir, "design lane directory");
    const manifestInfo = fs.lstatSync(manifestFile, { throwIfNoEntry: false });
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) fail(`unsafe design lane manifest: ${manifestFile}`);
    validateExistingManifest(readJson(manifestFile), options);
  } else {
    if (contract.revision !== 1) fail("a new design lane requires Context Revision: 1");
    fs.mkdirSync(laneDir, { recursive: false });
    try {
      requireSymlinkFreeContainedPath(options.workdir, laneDir, "design lane directory");
      (dependencies.writeJsonAtomic || writeJsonAtomic)(manifestFile, initialManifest(options));
    } catch (error) {
      fs.rmSync(laneDir, { recursive: true, force: true });
      throw error;
    }
  }

  const send = (sender, sessionId, address, subject, body, label) => {
    return sendWaypostWithNudgeRetry({
      label,
      sessionHost: options.sessionHost,
      sessionId,
      sender,
      sendOptions: options,
      toAddress: address,
      subject,
      message: body,
      runCommand: runWaypost,
      readDeliveryCommand: dependencies.runWaypostRead || run,
      runNudgeCommand: dependencies.runNudge || run
    });
  };

  const reviewer = send(
    sendDesignSpecReviewContextMessage,
    options.reviewerSessionId,
    options.reviewerToAddress,
    `design-spec context: ${options.taskId} -> reviewer`,
    reviewerBody(options),
    "reviewer context"
  );
  let pruner = null;
  if (options.prunerSessionId) {
    pruner = send(
      sendDesignPruneContextMessage,
      options.prunerSessionId,
      options.prunerToAddress,
      `design-spec context: ${options.taskId} -> pruner`,
      prunerBody(options),
      "pruner context"
    );
  }

  const author = send(
    sendDesignSpecDraftRequestedMessage,
    options.authorSessionId,
    options.authorToAddress,
    `design-spec draft: ${options.taskId} r1`,
    authorBody(options),
    "author draft"
  );

  const summary = {
    status: "sent",
    manifest_file: manifestFile,
    ...stageSummary("reviewer_context", reviewer),
    ...stageSummary("pruner_context", pruner),
    ...stageSummary("author_draft", author)
  };
  const prunerText = pruner
    ? ` pruner_context_delivery_id=${pruner.receipt.delivery_id} pruner_context_notify_status=${pruner.notification.status}`
    : "";
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : `Design draft dispatched: ${options.taskId} reviewer_delivery_id=${reviewer.receipt.delivery_id} reviewer_notify_status=${reviewer.notification.status}${prunerText} author_delivery_id=${author.receipt.delivery_id} author_notify_status=${author.notification.status}\n`);
}

if (isMain(import.meta.url)) execute(main);
