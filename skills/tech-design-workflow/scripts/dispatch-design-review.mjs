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
  --pruner-baseline-artifact <workspace-relative-path>
                                  Last artifact that received MINIMAL
  --major-structure-change      Mark a material structural change since that baseline
  --pruner-only                 Send this artifact only to the pruner
  --pruner-session-id <id>      Supply the lazy pruner when this dispatch requires it
  --pruner-to-address <address> Supply the lazy pruner when this dispatch requires it
  --content-type <type>         Default: text/markdown
  --schema-version <value>      Default: 1
  --send-timeout-ms <ms>        Default: 0
  --json
  -h, --help

The program reads the stable lane manifest and layered TOML policy, measures the
artifact and cumulative growth since the last MINIMAL baseline, then sends the
required review requests. It never writes workflow state.`;

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

export function measureGrowth(baselineSource, currentSource) {
  const baseline = measureDesign(baselineSource);
  const current = measureDesign(currentSource);
  return {
    addedLines: Math.max(0, current.lines - baseline.lines),
    addedChars: Math.max(0, current.chars - baseline.chars)
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

function requirePruner(manifest, options, reason) {
  const supplied = Boolean(options.prunerSessionId || options.prunerToAddress);
  if (Boolean(options.prunerSessionId) !== Boolean(options.prunerToAddress)) {
    fail("--pruner-session-id and --pruner-to-address must be provided together");
  }
  if (manifest.pruner_policy === "always") {
    if (supplied) fail("the lane manifest already records its pruner");
    return {
      sessionId: manifest.pruner_session_id,
      address: manifest.pruner_to_address,
      reason
    };
  }
  if (!supplied) {
    fail(`design requires ${reason}; activate the lane's design_pruner and rerun`, 3, "PRUNER_REQUIRED");
  }
  plain(options.prunerSessionId, "--pruner-session-id");
  plain(options.prunerToAddress, "--pruner-to-address");
  const ids = [manifest.requester_session_id, manifest.author_session_id, manifest.reviewer_session_id];
  const addresses = [manifest.requester_address, manifest.author_to_address, manifest.reviewer_to_address];
  if (ids.includes(options.prunerSessionId)) fail("pruner session id must be distinct");
  if (addresses.includes(options.prunerToAddress)) fail("pruner address must be distinct");
  return { sessionId: options.prunerSessionId, address: options.prunerToAddress, reason };
}

function resolvePruner(manifest, options, evidence) {
  const supplied = Boolean(options.prunerSessionId || options.prunerToAddress);
  if (Boolean(options.prunerSessionId) !== Boolean(options.prunerToAddress)) {
    fail("--pruner-session-id and --pruner-to-address must be provided together");
  }
  if (manifest.pruner_policy === "never") {
    if (supplied || options.prunerOnly) fail("the lane explicitly disables pruning");
    return null;
  }
  if (options.prunerOnly) return requirePruner(manifest, options, "pruner-only dispatch");

  let reason = null;
  if (!evidence.baselineArtifact && manifest.pruner_policy === "always") {
    reason = "initial no-threshold review";
  } else if (!evidence.baselineArtifact && evidence.thresholdReached) {
    reason = "initial complexity review";
  } else if (evidence.baselineArtifact && options.majorStructureChange) {
    reason = "major structural change";
  } else if (evidence.baselineArtifact && evidence.growthThresholdReached) {
    reason = "substantial cumulative content growth";
  }
  if (!reason) {
    if (supplied) fail("this revision does not require a pruner recheck");
    return null;
  }
  return requirePruner(manifest, options, reason);
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
      "--workdir", "--lane-manifest", "--artifact", "--previous-artifact", "--pruner-baseline-artifact", "--round",
      "--context-revision", "--pruner-session-id", "--pruner-to-address",
      "--content-type", "--schema-version", "--send-timeout-ms"
    ],
    flags: ["--major-structure-change", "--pruner-only", "--json"],
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
        + `analyze and report structural risks and affected outcomes to the user, then stop, redirect, or continue and advance the checkpoint`,
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
  if (options.prunerOnly && (options.prunerBaselineArtifact || options.majorStructureChange)) {
    fail("--pruner-only cannot be combined with baseline or structural-change options");
  }

  let baselineFile = null;
  if (options.prunerBaselineArtifact) {
    if (manifest.pruner_policy === "never") fail("--pruner-baseline-artifact is not valid with never policy");
    const prefix = path.posix.join(".agent-artifacts", "design-spec", manifest.author_session_id);
    const match = /^r([0-9]{3,})\.md$/.exec(path.posix.basename(options.prunerBaselineArtifact));
    const baselineRound = match ? Number(match[1]) : 0;
    if (path.posix.dirname(options.prunerBaselineArtifact) !== prefix
      || !baselineRound || baselineRound >= options.round
      || options.prunerBaselineArtifact !== expectedArtifactPath(manifest.author_session_id, baselineRound)) {
      fail("--pruner-baseline-artifact must be an earlier immutable artifact for this author");
    }
    baselineFile = resolveWorkspaceFile(workdir, options.prunerBaselineArtifact, "pruner baseline artifact");
  }
  if (options.majorStructureChange && !baselineFile) {
    fail("--major-structure-change requires --pruner-baseline-artifact");
  }

  const contractFile = resolveWorkspaceFile(workdir, manifest.context_file, "canonical contract");
  const contract = readContract(contractFile, fs.readFileSync, false);
  if (contract.revision !== options.contextRevision) fail("--context-revision does not match the Canonical Contract");

  const policy = (dependencies.loadPolicy || loadWorkflowPolicy)({
    cwd: workdir,
    env: dependencies.env || process.env,
    homeDir: dependencies.homeDir
  });
  const artifactSource = fs.readFileSync(artifactFile, "utf8");
  const metrics = measureDesign(artifactSource);
  const growth = baselineFile
    ? measureGrowth(fs.readFileSync(baselineFile, "utf8"), artifactSource)
    : { addedLines: 0, addedChars: 0 };
  const thresholdReached = metrics.lines >= policy.maxLines || metrics.chars >= policy.maxChars;
  const growthThresholdReached = Boolean(baselineFile)
    && (growth.addedLines >= policy.recheckAddedLines || growth.addedChars >= policy.recheckAddedChars);
  const pruner = resolvePruner(manifest, options, {
    thresholdReached,
    baselineArtifact: options.prunerBaselineArtifact,
    growthThresholdReached
  });

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
  const reviewer = options.prunerOnly ? null : send(
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
    pruner_baseline_artifact: options.prunerBaselineArtifact || null,
    added_lines_since_pruner: baselineFile ? growth.addedLines : null,
    added_chars_since_pruner: baselineFile ? growth.addedChars : null,
    major_structure_change: Boolean(options.majorStructureChange),
    pruner_only: Boolean(options.prunerOnly),
    reviewer_requested: Boolean(reviewer),
    pruner_requested: Boolean(pruner),
    pruner_reason: pruner?.reason || null,
    ...stageSummary("reviewer", reviewer),
    ...stageSummary("pruner", prunerResult)
  };
  const prunerText = prunerResult
    ? ` pruner_delivery_id=${prunerResult.receipt.delivery_id} pruner_notify_status=${prunerResult.notification.status}`
    : "";
  const textSummary = options.prunerOnly
    ? `Pruner-only dispatch: ${manifest.task_id} r${options.round}${prunerText}\n`
    : `Design review dispatched: ${manifest.task_id} r${options.round} reviewer_delivery_id=${reviewer.receipt.delivery_id} reviewer_notify_status=${reviewer.notification.status}${prunerText}\n`;
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : textSummary);
}

if (isMain(import.meta.url)) execute(main);
