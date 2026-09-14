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
  expectedNotesPath,
  readContract,
  requireSymlinkFreeContainedPath,
  sendWaypostWithNudgeRetry,
  stageSummary
} from "./send-design-draft-with-review-context.mjs";
import { loadWorkflowPolicy } from "./workflow-policy.mjs";

const usage = `Measure one design artifact and dispatch its review without changing lane data.

Required:
  --lane-manifest <workspace-relative-path>
  --artifact <workspace-relative-path>
  --round <positive-integer>
  --context-revision <positive-integer>

Optional:
  --phase <structure|implementation>
                                  Required on a two-phase lane: structure
                                  rounds use sNNN.md and may include the
                                  pruner; implementation rounds use rNNN.md,
                                  require the recorded structure document,
                                  and never include the pruner. A single-phase
                                  lane uses rNNN.md only.
  --structure-doc <workspace-relative-path>
                                  Required for an implementation-phase dispatch:
                                  the accepted structure document recorded in
                                  the lane manifest. Naming it forces the author
                                  to acknowledge the current structural baseline.
  --previous-artifact <workspace-relative-path>
  --rationale-file <workspace-relative-path>
                                  This round's sNNN/rNNN.notes.md, carried in the
                                  request body: finding dispositions, and at
                                  checkpoint rounds the convergence assessment.
                                  Required for round 2 and later
  --pruner-baseline-artifact <workspace-relative-path>
                                  Last same-phase artifact that received MINIMAL
  --major-structure-change      Mark a material structural change since that baseline
  --pruner-only                 Send this artifact only to the pruner
  --pruner-session-id <id>      Supply the lazy pruner when this dispatch requires it
  --pruner-to-address <address> Supply the lazy pruner when this dispatch requires it
  --content-type <type>         Default: text/markdown
  --schema-version <value>      Default: 1
  --send-timeout-ms <ms>        Default: 0
  --json
  -h, --help

Run from the author workspace. Paths resolve from the current directory.
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
  if (!pathInside(workdir, filePath)) fail(`${label} escapes the current workspace`);
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
  if (manifest.design_phases !== undefined && !["two", "single"].includes(manifest.design_phases)) {
    fail("lane manifest design_phases is invalid");
  }
  if (manifest.design_phases === "two") {
    for (const field of ["structure_checkpoint", "initial_review_checkpoint"]) {
      if (!Number.isInteger(manifest[field]) || manifest[field] <= 0) {
        fail(`lane manifest ${field} is invalid`);
      }
    }
    if (manifest.structure_doc !== undefined) {
      plain(manifest.structure_doc, "lane manifest structure_doc");
      const match = /^s([0-9]{3,})\.md$/.exec(path.posix.basename(manifest.structure_doc));
      const prefix = path.posix.join(".agent-artifacts", "design-spec", manifest.author_session_id);
      if (!match || path.posix.dirname(manifest.structure_doc) !== prefix) {
        fail("lane manifest structure_doc is not an sNNN artifact of this author");
      }
    }
    if (manifest.structure_amendment_pending !== undefined && manifest.structure_amendment_pending !== true) {
      fail("lane manifest structure_amendment_pending is invalid");
    }
  } else if (manifest.structure_doc !== undefined || manifest.structure_amendment_pending !== undefined) {
    fail("a single-phase lane manifest must not record structure state");
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

function reviewMessage(factory, manifest, options, body) {
  return factory({
    before: [{ name: "Task", value: manifest.task_id }],
    after: [
      { name: "Lane Manifest", value: options.laneManifest },
      ...(manifest.design_phases === "two" ? [{ name: "Phase", value: options.phase }] : []),
      { name: "Artifact", value: options.artifact },
      ...(options.phase === "implementation" && manifest.structure_doc
        ? [{ name: "Structure", value: manifest.structure_doc }] : []),
      ...(options.previousArtifact ? [{ name: "Previous Artifact", value: options.previousArtifact }] : []),
      { name: "Context Revision", value: String(options.contextRevision) },
      { name: "Round", value: String(options.round) }
    ],
    body
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, {
    values: [
      "--lane-manifest", "--artifact", "--previous-artifact", "--pruner-baseline-artifact", "--round",
      "--context-revision", "--pruner-session-id", "--pruner-to-address",
      "--rationale-file", "--content-type", "--schema-version", "--send-timeout-ms", "--phase",
      "--structure-doc"
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
    ["laneManifest", "--lane-manifest"], ["artifact", "--artifact"],
    ["round", "--round"], ["contextRevision", "--context-revision"]
  ]) if (!options[field]) fail(`${label} is required`);
  options.round = positiveInteger(options.round, "--round");
  options.contextRevision = positiveInteger(options.contextRevision, "--context-revision");
  options.sendTimeoutMs = nonNegativeInteger(options.sendTimeoutMs, "--send-timeout-ms");
  (dependencies.requireCommand || requireCommand)("waypost");

  const workdir = fs.realpathSync(dependencies.cwd || process.cwd());
  const manifestFile = resolveWorkspaceFile(workdir, options.laneManifest, "lane manifest");
  const manifest = readJson(manifestFile);
  validateManifest(manifest);

  const twoPhase = manifest.design_phases === "two";
  if (twoPhase) {
    if (!options.phase) fail("--phase is required for a two-phase lane");
    if (!["structure", "implementation"].includes(options.phase)) {
      fail("--phase must be structure or implementation");
    }
    if (options.phase === "implementation") {
      if (!manifest.structure_doc) {
        fail(
          "implementation dispatch requires an accepted structure document; "
            + "record it with record-design-structure.mjs after the structure delivery is accepted"
        );
      }
      if (manifest.structure_amendment_pending) {
        fail(
          "a structure amendment is in flight; implementation rounds wait until "
            + "record-design-structure.mjs records the newly accepted structure document"
        );
      }
      if (!options.structureDoc) {
        fail("--structure-doc is required for an implementation-phase dispatch");
      }
      plain(options.structureDoc, "--structure-doc");
      if (options.structureDoc !== manifest.structure_doc) {
        fail("--structure-doc does not match the lane manifest's recorded structure document");
      }
    } else if (options.structureDoc) {
      fail("--structure-doc is only valid for an implementation-phase dispatch");
    }
  } else {
    if (options.phase && options.phase !== "implementation") {
      fail("a single-phase lane uses only rNNN artifacts; --phase structure is not valid");
    }
    if (options.structureDoc) fail("--structure-doc is not valid for a single-phase lane");
    options.phase = "implementation";
  }

  const reviewGate = options.phase === "structure" ? manifest.structure_checkpoint : manifest.review_checkpoint;
  if (options.round > reviewGate) {
    fail(
      `round ${options.round} crosses the ${options.phase} review checkpoint at ${reviewGate}; `
        + `run the tech-design-workflow/author-convergence assessment in the round notes, `
        + `then advance the checkpoint on convergence evidence or report the structural risk to the user and stop`,
      3,
      "USER_CHECKPOINT_REQUIRED"
    );
  }

  const expectedArtifact = expectedArtifactPath(manifest.author_session_id, options.round, options.phase);
  if (options.artifact !== expectedArtifact) fail(`--artifact must equal ${expectedArtifact}`);
  const artifactFile = resolveWorkspaceFile(workdir, options.artifact, "artifact");
  if (options.round === 1 && options.previousArtifact) fail("--previous-artifact is not valid for round 1");
  if (options.round > 1) {
    const expectedPrevious = expectedArtifactPath(manifest.author_session_id, options.round - 1, options.phase);
    if (options.previousArtifact !== expectedPrevious) fail(`--previous-artifact must equal ${expectedPrevious}`);
    resolveWorkspaceFile(workdir, options.previousArtifact, "previous artifact");
  }
  const pruningApplies = !twoPhase || options.phase === "structure";
  if (!pruningApplies) {
    if (options.prunerOnly || options.prunerBaselineArtifact || options.majorStructureChange
      || options.prunerSessionId || options.prunerToAddress) {
      fail("implementation-phase dispatches never include the pruner; structure changes route through an sNNN amendment");
    }
  }
  if (options.prunerOnly && (options.prunerBaselineArtifact || options.majorStructureChange)) {
    fail("--pruner-only cannot be combined with baseline or structural-change options");
  }

  let baselineFile = null;
  if (options.prunerBaselineArtifact) {
    if (manifest.pruner_policy === "never") fail("--pruner-baseline-artifact is not valid with never policy");
    const prefix = path.posix.join(".agent-artifacts", "design-spec", manifest.author_session_id);
    const letter = options.phase === "structure" ? "s" : "r";
    const match = new RegExp(`^${letter}([0-9]{3,})\\.md$`).exec(path.posix.basename(options.prunerBaselineArtifact));
    const baselineRound = match ? Number(match[1]) : 0;
    if (path.posix.dirname(options.prunerBaselineArtifact) !== prefix
      || !baselineRound || baselineRound >= options.round
      || options.prunerBaselineArtifact !== expectedArtifactPath(manifest.author_session_id, baselineRound, options.phase)) {
      fail("--pruner-baseline-artifact must be an earlier immutable same-phase artifact for this author");
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

  let rationale = "";
  if (options.rationaleFile) {
    if (options.round === 1) fail("--rationale-file is not valid for round 1");
    const expectedRationale = expectedNotesPath(manifest.author_session_id, options.round, options.phase);
    if (options.rationaleFile !== expectedRationale) {
      fail(`--rationale-file must equal ${expectedRationale}`);
    }
    const rationaleFile = resolveWorkspaceFile(workdir, options.rationaleFile, "--rationale-file");
    rationale = fs.readFileSync(rationaleFile, "utf8").trim();
    if (!rationale) fail("--rationale-file is empty");
    const rationaleMetrics = measureDesign(rationale);
    if (rationaleMetrics.lines > policy.maxLines || rationaleMetrics.chars > policy.maxChars) {
      fail("--rationale-file exceeds the workflow policy limit");
    }
  } else if (options.round > 1) {
    fail("--rationale-file is required for round 2 and later");
  }
  const thresholdReached = metrics.lines >= policy.maxLines || metrics.chars >= policy.maxChars;
  const growthThresholdReached = Boolean(baselineFile)
    && (growth.addedLines >= policy.recheckAddedLines || growth.addedChars >= policy.recheckAddedChars);
  const pruner = pruningApplies ? resolvePruner(manifest, options, {
    thresholdReached,
    baselineArtifact: options.prunerBaselineArtifact,
    growthThresholdReached
  }) : null;

  const sendOptions = {
    fromAddress: manifest.author_to_address,
    contentType: options.contentType,
    schemaVersion: options.schemaVersion,
    sendTimeoutMs: options.sendTimeoutMs
  };
  const send = async (sender, sessionId, address, subject, body, label) => {
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
      runNudgeCommand: dependencies.runNudge,
      stderr: dependencies.stderr || process.stderr
    });
  };
  const letter = options.phase === "structure" ? "s" : "r";
  const reviewer = options.prunerOnly ? null : await send(
    sendDesignSpecReviewRequestedMessage,
    manifest.reviewer_session_id,
    manifest.reviewer_to_address,
    `design-spec review: ${manifest.task_id} ${letter}${options.round}`,
    reviewMessage(designSpecReviewRequestedMessage, manifest, options, rationale),
    "design review"
  );
  let prunerResult = null;
  if (pruner) {
    prunerResult = await send(
      sendDesignPruneRequestedMessage,
      pruner.sessionId,
      pruner.address,
      `design prune: ${manifest.task_id} ${letter}${options.round}`,
      reviewMessage(designPruneRequestedMessage, manifest, options, rationale),
      "design prune"
    );
  }
  const summary = {
    status: "sent",
    artifact: options.artifact,
    phase: options.phase,
    structure_doc: manifest.structure_doc || null,
    round: options.round,
    rationale_file: options.rationaleFile || null,
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
    ? `Pruner-only dispatch: ${manifest.task_id} ${letter}${options.round}${prunerText}\n`
    : `Design review dispatched: ${manifest.task_id} ${letter}${options.round} reviewer_delivery_id=${reviewer.receipt.delivery_id} reviewer_notify_status=${reviewer.notification.status}${prunerText}\n`;
  process.stdout.write(options.json
    ? `${JSON.stringify(summary)}\n`
    : textSummary);
}

if (isMain(import.meta.url)) execute(main);
