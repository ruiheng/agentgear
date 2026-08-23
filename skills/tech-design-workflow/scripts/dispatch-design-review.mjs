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
  requireCommand
} from "../../multi-agent-protocol/scripts/workflow-lib.mjs";
import {
  designPruneRequestedMessage,
  designSpecReviewRequestedMessage,
  sendDesignPruneRequestedMessage,
  sendDesignSpecReviewRequestedMessage
} from "./action-producers.mjs";
import {
  expectedArtifactPath,
  readContract,
  requireSymlinkFreeContainedPath,
  sendWaypostWithNudgeRetry,
  stageSummary
} from "./send-design-draft-with-review-context.mjs";
import { loadWorkflowPolicy } from "./workflow-policy.mjs";

const usage = `Measure one design artifact and dispatch its review without changing lane data.

Required:
  --workdir <path>
  --lane-manifest <workspace-relative-path>
  --artifact <workspace-relative-path>
  --round <positive-integer>
  --context-revision <positive-integer>

Optional:
  --previous-artifact <workspace-relative-path>
  --pruner-session-id <id>      Supply the lazy pruner when the threshold requires it
  --pruner-to-address <address> Supply the lazy pruner when the threshold requires it
  --content-type <type>         Default: text/markdown
  --schema-version <value>      Default: 1
  --send-timeout-ms <ms>        Default: 0
  --json
  -h, --help

The program reads the stable lane manifest and layered TOML policy, measures the
artifact, then sends review requests. It never writes workflow state.`;

function plain(value, label) {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) fail(`${label} has an unsafe value`);
  return value;
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value || "")) fail(`${label} must be a positive integer`);
  return Number(value);
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

function resolveWorkspaceFile(workdir, relativePath, label) {
  if (path.isAbsolute(relativePath)) fail(`${label} must be workspace-relative`);
  const filePath = path.resolve(workdir, relativePath);
  if (!pathInside(workdir, filePath)) fail(`${label} escapes --workdir`);
  requireSymlinkFreeContainedPath(workdir, path.dirname(filePath), `${label} parent`);
  safeRegularFile(filePath, label);
  return filePath;
}

export function measureDesign(source) {
  return {
    lines: source.split(/\r?\n/).filter(line => line.trim()).length,
    chars: [...source.replace(/\s/gu, "")].length
  };
}

function validateManifest(manifest) {
  if (manifest?.schema_version !== 2) fail("design lane manifest must use schema 2");
  for (const field of [
    "task_id", "requester_session_id", "requester_address", "author_session_id",
    "author_to_address", "reviewer_session_id", "reviewer_to_address", "session_host",
    "context_file", "archive_branch", "pruner_policy"
  ]) plain(manifest[field], `lane manifest ${field}`);
  if (!Number.isInteger(manifest.review_checkpoint) || manifest.review_checkpoint <= 0) {
    fail("lane manifest review_checkpoint is invalid");
  }
  if (!Number.isInteger(manifest.review_checkpoint_interval) || manifest.review_checkpoint_interval <= 0) {
    fail("lane manifest review_checkpoint_interval is invalid");
  }
  if (!["auto", "always", "never"].includes(manifest.pruner_policy)) {
    fail("lane manifest pruner_policy is invalid");
  }
  const hasInitialPruner = Boolean(manifest.pruner_session_id || manifest.pruner_to_address);
  if (Boolean(manifest.pruner_session_id) !== Boolean(manifest.pruner_to_address)) {
    fail("lane manifest has an incomplete initial pruner identity");
  }
  if ((manifest.pruner_policy === "always") !== hasInitialPruner) {
    fail("lane manifest initial pruner does not match pruner_policy");
  }
}

function resolvePruner(manifest, options, thresholdReached) {
  const supplied = Boolean(options.prunerSessionId || options.prunerToAddress);
  if (Boolean(options.prunerSessionId) !== Boolean(options.prunerToAddress)) {
    fail("--pruner-session-id and --pruner-to-address must be provided together");
  }
  if (manifest.pruner_policy === "always") {
    if (supplied) fail("the lane manifest already records its required pruner");
    return { sessionId: manifest.pruner_session_id, address: manifest.pruner_to_address };
  }
  if (manifest.pruner_policy === "never") {
    if (supplied) fail("the lane explicitly disables pruning");
    return null;
  }
  if (!thresholdReached) {
    if (supplied) fail("the design does not reach the lazy-pruner threshold");
    return null;
  }
  if (!supplied) {
    fail("design reaches the configured threshold; activate a design_pruner and rerun", 3, "PRUNER_REQUIRED");
  }
  plain(options.prunerSessionId, "--pruner-session-id");
  plain(options.prunerToAddress, "--pruner-to-address");
  const ids = [manifest.requester_session_id, manifest.author_session_id, manifest.reviewer_session_id];
  const addresses = [manifest.requester_address, manifest.author_to_address, manifest.reviewer_to_address];
  if (ids.includes(options.prunerSessionId)) fail("pruner session id must be distinct");
  if (addresses.includes(options.prunerToAddress)) fail("pruner address must be distinct");
  return { sessionId: options.prunerSessionId, address: options.prunerToAddress };
}

function reviewMessage(factory, manifest, options) {
  return factory({
    before: [{ name: "Task", value: manifest.task_id }],
    after: [
      { name: "Lane Manifest", value: options.laneManifest },
      { name: "Artifact", value: options.artifact },
      ...(options.previousArtifact ? [{ name: "Previous Artifact", value: options.previousArtifact }] : []),
      { name: "Context Revision", value: String(options.contextRevision) },
      { name: "Round", value: String(options.round) }
    ],
    body: ""
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: [
      "--workdir", "--lane-manifest", "--artifact", "--previous-artifact", "--round",
      "--context-revision", "--pruner-session-id", "--pruner-to-address",
      "--content-type", "--schema-version", "--send-timeout-ms"
    ],
    flags: ["--json"],
    defaults: {
      contentType: "text/markdown",
      schemaVersion: "1",
      sendTimeoutMs: "0",
      json: false
    }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [field, label] of [
    ["workdir", "--workdir"], ["laneManifest", "--lane-manifest"], ["artifact", "--artifact"],
    ["round", "--round"], ["contextRevision", "--context-revision"]
  ]) if (!options[field]) fail(`${label} is required`);
  options.round = positiveInteger(options.round, "--round");
  options.contextRevision = positiveInteger(options.contextRevision, "--context-revision");
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  (dependencies.requireCommand || requireCommand)("waypost");

  const requestedWorkdir = path.resolve(options.workdir);
  if (!fs.statSync(requestedWorkdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${requestedWorkdir}`);
  }
  const workdir = fs.realpathSync(requestedWorkdir);
  const manifestFile = resolveWorkspaceFile(workdir, options.laneManifest, "lane manifest");
  const manifest = readJson(manifestFile);
  validateManifest(manifest);
  if (options.round > manifest.review_checkpoint) {
    fail(
      `round ${options.round} crosses the user checkpoint at ${manifest.review_checkpoint}; `
        + `ask the user whether to stop, redirect, or continue, then advance the checkpoint`,
      3,
      "USER_CHECKPOINT_REQUIRED"
    );
  }

  const expectedArtifact = expectedArtifactPath(manifest.author_session_id, options.round);
  if (options.artifact !== expectedArtifact) fail(`--artifact must equal ${expectedArtifact}`);
  const artifactFile = resolveWorkspaceFile(workdir, options.artifact, "artifact");
  if (options.round === 1 && options.previousArtifact) fail("--previous-artifact is not valid for round 1");
  if (options.round > 1) {
    const expectedPrevious = expectedArtifactPath(manifest.author_session_id, options.round - 1);
    if (options.previousArtifact !== expectedPrevious) fail(`--previous-artifact must equal ${expectedPrevious}`);
    resolveWorkspaceFile(workdir, options.previousArtifact, "previous artifact");
  }

  const contractFile = resolveWorkspaceFile(workdir, manifest.context_file, "canonical contract");
  const contract = readContract(contractFile, fs.readFileSync, false);
  if (contract.revision !== options.contextRevision) fail("--context-revision does not match the Canonical Contract");

  const policy = (dependencies.loadPolicy || loadWorkflowPolicy)({
    cwd: workdir,
    env: dependencies.env || process.env,
    homeDir: dependencies.homeDir
  });
  const metrics = measureDesign(fs.readFileSync(artifactFile, "utf8"));
  const thresholdReached = metrics.lines >= policy.maxLines || metrics.chars >= policy.maxChars;
  const pruner = resolvePruner(manifest, options, thresholdReached);

  const sendOptions = {
    fromAddress: manifest.author_to_address,
    contentType: options.contentType,
    schemaVersion: options.schemaVersion,
    sendTimeoutMs: options.sendTimeoutMs
  };
  const send = (sender, sessionId, address, subject, body, label) => {
    return sendWaypostWithNudgeRetry({
      label,
      sessionHost: manifest.session_host,
      sessionId,
      sender,
      sendOptions,
      toAddress: address,
      subject,
      message: body,
      runCommand: dependencies.runWaypost,
      readDeliveryCommand: dependencies.runWaypostRead,
      runNudgeCommand: dependencies.runNudge
    });
  };
  const reviewer = send(
    sendDesignSpecReviewRequestedMessage,
    manifest.reviewer_session_id,
    manifest.reviewer_to_address,
    `design-spec review: ${manifest.task_id} r${options.round}`,
    reviewMessage(designSpecReviewRequestedMessage, manifest, options),
    "design review"
  );
  let prunerResult = null;
  if (pruner) {
    prunerResult = send(
      sendDesignPruneRequestedMessage,
      pruner.sessionId,
      pruner.address,
      `design prune: ${manifest.task_id} r${options.round}`,
      reviewMessage(designPruneRequestedMessage, manifest, options),
      "design prune"
    );
  }
  const summary = {
    status: "sent",
    artifact: options.artifact,
    round: options.round,
    lines: metrics.lines,
    chars: metrics.chars,
    pruner_requested: Boolean(pruner),
    ...stageSummary("reviewer", reviewer),
    ...stageSummary("pruner", prunerResult)
  };
  const prunerText = prunerResult
    ? ` pruner_delivery_id=${prunerResult.receipt.delivery_id} pruner_notify_status=${prunerResult.notification.status}`
    : "";
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : `Design review dispatched: ${manifest.task_id} r${options.round} reviewer_delivery_id=${reviewer.receipt.delivery_id} reviewer_notify_status=${reviewer.notification.status}${prunerText}\n`);
}

if (isMain(import.meta.url)) execute(main);
