import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SEND_TIMEOUT_MS,
  DELIVERY_STATE_TIMEOUT_MS,
  NUDGE_MESSAGE,
  expectedArtifactPath,
  main as dispatchDraft,
  readContract,
  sendOutputFrom,
  sendWaypost
} from "../skills/tech-design-workflow/scripts/send-design-draft-with-review-context.mjs";
import { AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS } from "../providers/session-hosts.mjs";
import {
  main as dispatchReview,
  measureDesign,
  measureGrowth
} from "../skills/tech-design-workflow/scripts/dispatch-design-review.mjs";
import { main as advanceReviewCheckpoint } from "../skills/tech-design-workflow/scripts/advance-design-review-checkpoint.mjs";
import {
  loadWorkflowPolicy,
  parseWorkflowPolicyToml
} from "../skills/tech-design-workflow/scripts/workflow-policy.mjs";
import { hasStickyTaskContextMarker } from "../skills/multi-agent-protocol/scripts/compact-memory-shared.mjs";

function fixture() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const messageDir = path.join(workdir, ".agent-artifacts", "message");
  fs.mkdirSync(messageDir, { recursive: true });
  const contractFile = path.join(messageDir, "task.md");
  fs.writeFileSync(contractFile, "Context Revision: 1\n\n## Original Request\nBuild it.\n");
  const manifestRelative = ".agent-artifacts/design-spec-dispatch/design-task.lock/lane.json";
  return {
    workdir,
    contractFile,
    manifestRelative,
    manifestFile: path.join(workdir, manifestRelative),
    args: [
      "--workdir", workdir,
      "--task-id", "design-task",
      "--requester-session-id", "requester-1",
      "--author-session-id", "author-1",
      "--reviewer-session-id", "reviewer-1",
      "--session-host", "agent-deck",
      "--review-checkpoint", "5",
      "--archive-branch", "main",
      "--from-address", "waypost/requester-1",
      "--author-to-address", "waypost/author-1",
      "--reviewer-to-address", "waypost/reviewer-1",
      "--contract-file", contractFile,
      "--json"
    ]
  };
}

function actionFrom(body) {
  return /^Action: ([^\n]+)$/m.exec(body)?.[1];
}

function successfulWaypost(records, hook) {
  let sequence = 0;
  return (command, args, options) => {
    sequence += 1;
    const record = { command, args, body: options.input };
    records.push(record);
    hook?.(record, sequence);
    return {
      status: 0,
      stdout: JSON.stringify({
        delivery_id: `delivery-${sequence}`,
        message_id: `message-${sequence}`,
        notify_status: "sent",
        notify_scheme: "test"
      }),
      stderr: "",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function writeArtifact(item, round, source) {
  const relative = expectedArtifactPath("author-1", round);
  const artifact = path.join(item.workdir, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, source);
  return { relative, artifact };
}

function waypostReadState(state, records = []) {
  return (command, args, options) => {
    records.push({ command, args, options });
    const deliveryId = args[2];
    return {
      status: 0,
      stdout: JSON.stringify({ items: [{ delivery_id: deliveryId, state }] }),
      stderr: "",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function successfulNudge(records) {
  return (command, args, options) => {
    records.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "", error: null, signal: null, timedOut: false };
  };
}

function waypostWithFailedPrunerNudge(records) {
  let sequence = 0;
  return (command, args, options) => {
    sequence += 1;
    const action = actionFrom(options.input);
    records.push({ command, args, action });
    const pruner = action.startsWith("design_prune_");
    return {
      status: 0,
      stdout: JSON.stringify({
        delivery_id: `delivery-${sequence}`,
        notify_status: pruner ? "failed" : "sent",
        ...(pruner ? { notify_error: "simulated pruner nudge failure" } : {})
      }),
      stderr: "",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function failedNudge(records) {
  return (command, args, options) => {
    records.push({ command, args, options });
    return {
      status: 1,
      stdout: "",
      stderr: "simulated direct nudge failure",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function reviewArgs(item, round = 1) {
  return [
    "--workdir", item.workdir,
    "--lane-manifest", item.manifestRelative,
    "--artifact", expectedArtifactPath("author-1", round),
    ...(round > 1 ? ["--previous-artifact", expectedArtifactPath("author-1", round - 1)] : []),
    "--round", String(round),
    "--context-revision", "1",
    "--json"
  ];
}

async function createLane(item, records = []) {
  return captureStdout(() => dispatchDraft(item.args, {
    requireCommand() {},
    runWaypost: successfulWaypost(records)
  }));
}

async function captureStdout(action) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("send parsing keeps delivery receipts as transport results", () => {
  assert.equal(DEFAULT_SEND_TIMEOUT_MS, 0);
  assert.deepEqual(sendOutputFrom(JSON.stringify({ delivery_id: "d1" })).receipt, { delivery_id: "d1" });
  const sent = sendWaypost(
    (message, options) => options.runCommand("waypost", ["send"], { input: message }),
    { fromAddress: "from", contentType: "text/markdown", schemaVersion: "1", sendTimeoutMs: 0 },
    "to", "subject", "body",
    () => ({ status: 0, stdout: "{\"delivery_id\":\"d1\"}", stderr: "", error: null, signal: null, timedOut: false })
  );
  assert.equal(sent.status, "sent");
});

test("initial dispatch writes one stable manifest and notifies reviewer before author", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item, records);
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context",
      "design_spec_draft_requested"
    ]);
    assert.equal(records.every(record => hasStickyTaskContextMarker(record.body)), true);
    const manifest = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.pruner_policy, "auto");
    assert.equal(manifest.context_file, ".agent-artifacts/message/task.md");
    assert.equal(manifest.review_checkpoint, 5);
    assert.equal(manifest.review_checkpoint_interval, 2);
    for (const dynamic of [
      "current_round", "current_artifact", "previous_artifact", "review_epoch",
      "correctness_report", "prune_report", "review_gate", "acceptance",
      "dispatch_ready", "artifact_sha256"
    ]) assert.equal(dynamic in manifest, false, dynamic);
    assert.match(records[1].body, /^Artifact: \.agent-artifacts\/design-spec\/author-1\/r001\.md$/m);
    assert.equal(fs.statSync(item.manifestFile).isFile(), true);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("always policy records and initializes one pruner", async () => {
  const item = fixture();
  const records = [];
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost(records) }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context", "design_prune_context", "design_spec_draft_requested"
    ]);
    assert.equal(records.every(record => hasStickyTaskContextMarker(record.body)), true);
    const manifest = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    assert.equal(manifest.pruner_policy, "always");
    assert.equal(manifest.pruner_session_id, "pruner-1");
    assert.equal(manifest.pruner_to_address, "waypost/pruner-1");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial text output reports an enabled pruner nudge failure", async () => {
  const item = fixture();
  const sends = [];
  const nudges = [];
  try {
    const stdout = await captureStdout(() => dispatchDraft([
      ...item.args.filter(argument => argument !== "--json"),
      "--pruner-policy", "always",
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: waypostWithFailedPrunerNudge(sends),
      runWaypostRead: waypostReadState("queued"),
      runNudge: failedNudge(nudges)
    }));
    assert.deepEqual(sends.map(record => record.action), [
      "design_spec_review_context", "design_prune_context", "design_spec_draft_requested"
    ]);
    assert.equal(nudges.length, 1);
    assert.match(stdout, /pruner_context_delivery_id=delivery-2/);
    assert.match(stdout, /pruner_context_notify_status=failed/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("setup rerun preserves manifest bytes and starts a new dispatch", async () => {
  const item = fixture();
  try {
    await createLane(item);
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const records = [];
    await createLane(item, records);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context", "design_spec_draft_requested"
    ]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("schema-1 lanes are rejected as an explicit hard cut", async () => {
  const item = fixture();
  try {
    await createLane(item);
    const legacy = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    legacy.schema_version = 1;
    legacy.max_review_rounds = legacy.review_checkpoint;
    delete legacy.review_checkpoint;
    delete legacy.review_checkpoint_interval;
    fs.writeFileSync(item.manifestFile, `${JSON.stringify(legacy)}\n`);

    await assert.rejects(dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }), /must use schema 2/);
    writeArtifact(item, 1, "# Design\n");
    await assert.rejects(dispatchReview(reviewArgs(item), {
      requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), /must use schema 2/);
    await assert.rejects(advanceReviewCheckpoint([
      "--workdir", item.workdir,
      "--lane-manifest", item.manifestRelative,
      "--expected-current-checkpoint", "5"
    ]), /must use schema 2/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("reviewer protocol consumes review checkpoints instead of review maxima", () => {
  const references = ["routes.md", "review-contract.md", "committed-docs-review.md", "message-delivery.md"]
    .map(name => fs.readFileSync(new URL(`../skills/review-tech-design/references/${name}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(references, /Max Review Rounds|max_review_rounds/);
  assert.match(references, /Review Checkpoint/);
  assert.match(references, /schema-2 lane manifest/);
});

test("draft reviewer decisions return to the author-owned Canonical Contract", () => {
  const reportHandling = fs.readFileSync(
    new URL("../skills/tech-design-workflow/references/report-handling.md", import.meta.url),
    "utf8"
  );
  const delivery = fs.readFileSync(
    new URL("../skills/review-tech-design/references/message-delivery.md", import.meta.url),
    "utf8"
  );
  const correction = fs.readFileSync(
    new URL("../skills/tech-design-workflow/references/context-correction.md", import.meta.url),
    "utf8"
  );
  const draftStart = fs.readFileSync(
    new URL("../skills/tech-design-workflow/references/draft-review-start.md", import.meta.url),
    "utf8"
  );
  const pruning = fs.readFileSync(
    new URL("../skills/prune-tech-design/references/disclosure-start.md", import.meta.url),
    "utf8"
  );
  assert.match(reportHandling, /For any draft report with `User Decisions`/);
  assert.match(reportHandling, /before revision or delivery/);
  assert.match(reportHandling, /initial prune-context rejection: requested pruner -> author/);
  assert.match(delivery, /Draft-review's author\s+records confirmed User Decision Deltas/);
  assert.match(delivery, /manifest's author address/);
  assert.match(pruning, /initial-context `NEEDS_INPUT` to the manifest author/);
  assert.match(correction, /The requester reports the failure and\s+does not edit the Contract/);
  assert.match(draftStart, /Action: design_task_context_revision/);
  assert.match(draftStart, /do not edit the author-owned Canonical Contract/);
});

test("partial durable failure leaves the stable lane manifest", async () => {
  const item = fixture();
  try {
    await assert.rejects(
      dispatchDraft(item.args, {
        requireCommand() {},
        runWaypost(command, args, options) {
          if (actionFrom(options.input) === "design_spec_draft_requested") {
            return { status: 1, stdout: "", stderr: "author unavailable", error: null, signal: null, timedOut: false };
          }
          return successfulWaypost([])(command, args, options);
        }
      }),
      /author draft send failed/
    );
    const before = fs.readFileSync(item.manifestFile, "utf8");
    await createLane(item);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch retries failed nudges inside the same invocation", async () => {
  const item = fixture();
  const records = [];
  try {
    const notifyFailed = (command, args, options) => {
      records.push({ command, args, body: options.input });
      return {
        status: 0,
        stdout: JSON.stringify({
          delivery_id: `delivery-${records.length}`,
          notify_status: "failed",
          notify_scheme: "test",
          notify_error: "simulated nudge failure"
        }),
        stderr: "",
        error: null,
        signal: null,
        timedOut: false
      };
    };
    const reads = [];
    const nudges = [];
    const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost: notifyFailed,
      runWaypostRead: waypostReadState("queued", reads),
      runNudge: successfulNudge(nudges)
    })));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_context", "design_spec_draft_requested"
    ]);
    assert.equal(reads.length, 2);
    assert.equal(nudges.length, 2);
    assert.deepEqual(nudges.map(item => item.command), ["agent-deck", "agent-deck"]);
    assert.deepEqual(nudges.map(item => item.options.timeoutMs), [
      AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS,
      AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS
    ]);
    assert.deepEqual(reads.map(item => item.options.timeoutMs), [
      DELIVERY_STATE_TIMEOUT_MS,
      DELIVERY_STATE_TIMEOUT_MS
    ]);
    assert.deepEqual(reads.map(item => item.args[2]), ["delivery-1", "delivery-2"]);
    assert.deepEqual(nudges.map(item => item.args.at(-2)), ["reviewer-1", "author-1"]);
    assert.deepEqual(nudges.map(item => item.args.at(-1)), [NUDGE_MESSAGE, NUDGE_MESSAGE]);
    assert.equal(result.reviewer_context_notify_status, "sent");
    assert.equal(result.reviewer_context_notify_error, null);
    assert.equal(result.reviewer_context_nudge_retry_count, 1);
    assert.equal(result.author_draft_nudge_retry_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch replays target_queued notifications that never attempted a nudge", async () => {
  const item = fixture();
  const nudges = [];
  try {
    const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost(command, args, options) {
        return {
          status: 0,
          stdout: JSON.stringify({
            delivery_id: options.input.includes("design_spec_review_context") ? "reviewer-delivery" : "author-delivery",
            notify_status: "target_queued"
          }),
          stderr: "",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runWaypostRead: waypostReadState("queued"),
      runNudge: successfulNudge(nudges)
    })));
    assert.equal(nudges.length, 2);
    assert.equal(result.reviewer_context_notify_status, "sent");
    assert.equal(result.reviewer_context_nudge_retry_count, 1);
    assert.equal(result.author_draft_nudge_retry_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch does not replay notification outcomes that need no wake", async () => {
  for (const notifyStatus of ["skipped_local", "skipped_disabled", "skipped_already_claimed"]) {
    const item = fixture();
    const nudges = [];
    try {
      const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
        requireCommand() {},
        runWaypost(command, args, options) {
          return {
            status: 0,
            stdout: JSON.stringify({
              delivery_id: options.input.includes("design_spec_review_context") ? "reviewer-delivery" : "author-delivery",
              notify_status: notifyStatus
            }),
            stderr: "",
            error: null,
            signal: null,
            timedOut: false
          };
        },
        runWaypostRead() {
          throw new Error(`delivery state must not be read for ${notifyStatus}`);
        },
        runNudge: successfulNudge(nudges)
      })));
      assert.deepEqual(nudges, []);
      assert.equal(result.reviewer_context_notify_status, notifyStatus);
      assert.equal(result.reviewer_context_nudge_retry_count, 0);
      assert.equal(result.author_draft_notify_status, notifyStatus);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }
});

test("initial dispatch skips retry nudge when the delivery is already leased", async () => {
  const item = fixture();
  try {
    const failedNotify = [];
    const nudges = [];
    const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost(command, args, options) {
        failedNotify.push(options.input);
        return {
          status: 0,
          stdout: JSON.stringify({ delivery_id: `delivery-${failedNotify.length}`, notify_status: "failed" }),
          stderr: "",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runWaypostRead: waypostReadState("leased"),
      runNudge: successfulNudge(nudges)
    })));
    assert.deepEqual(nudges, []);
    assert.equal(result.reviewer_context_notify_status, "skipped_already_claimed");
    assert.equal(result.reviewer_context_nudge_retry_count, 0);
    assert.equal(result.author_draft_notify_status, "skipped_already_claimed");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch replays a nudge when delivery state cannot be read", async () => {
  const item = fixture();
  const nudges = [];
  try {
    const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost(command, args, options) {
        return {
          status: 0,
          stdout: JSON.stringify({
            delivery_id: options.input.includes("design_spec_review_context") ? "reviewer-delivery" : "author-delivery",
            notify_status: "unknown"
          }),
          stderr: "",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runWaypostRead(command, args, options) {
        assert.equal(options.timeoutMs, DELIVERY_STATE_TIMEOUT_MS);
        return {
          status: 1,
          stdout: "",
          stderr: "state unavailable",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runNudge: successfulNudge(nudges)
    })));
    assert.equal(nudges.length, 2);
    assert.equal(result.reviewer_context_nudge_delivery_state, "unknown");
    assert.equal(result.reviewer_context_nudge_retry_count, 1);
    assert.equal(result.author_draft_nudge_retry_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("direct nudge timeout and signal are reported as failed attempts", async () => {
  const item = fixture();
  let attempts = 0;
  try {
    const result = JSON.parse(await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {},
      runWaypost(command, args, options) {
        return {
          status: 0,
          stdout: JSON.stringify({
            delivery_id: options.input.includes("design_spec_review_context") ? "reviewer-delivery" : "author-delivery",
            notify_status: "failed"
          }),
          stderr: "",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runWaypostRead: waypostReadState("queued"),
      runNudge(command, args, options) {
        assert.equal(options.timeoutMs, AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS);
        attempts += 1;
        return attempts === 1
          ? { status: 1, stdout: "", stderr: "", error: null, signal: "SIGTERM", timedOut: true }
          : { status: 0, stdout: "", stderr: "", error: null, signal: "SIGTERM", timedOut: false };
      }
    })));
    assert.equal(result.reviewer_context_notify_status, "failed");
    assert.equal(
      result.reviewer_context_notify_error,
      `nudge timed out after ${AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS}ms`
    );
    assert.equal(result.author_draft_notify_status, "failed");
    assert.equal(result.author_draft_notify_error, "nudge terminated by SIGTERM");
    assert.equal(result.reviewer_context_nudge_retry_count, 1);
    assert.equal(result.author_draft_nudge_retry_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("initial dispatch rejects contradictory pruner policy and unsafe lane parents", async () => {
  for (const { extra, error } of [
    { extra: ["--pruner-policy", "always"], error: /always requires pruner session and address/ },
    {
      extra: ["--pruner-policy", "auto", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost\/pruner-1"],
      error: /auto must defer pruner creation/
    },
    {
      extra: ["--pruner-policy", "never", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost\/pruner-1"],
      error: /never cannot include a pruner session/
    }
  ]) {
    const item = fixture();
    try {
      await assert.rejects(dispatchDraft([...item.args, ...extra], {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }), error);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }

  const item = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-lane-external-"));
  try {
    fs.mkdirSync(path.join(item.workdir, ".agent-artifacts"), { recursive: true });
    fs.symlinkSync(external, path.join(item.workdir, ".agent-artifacts", "design-spec-dispatch"), "dir");
    await assert.rejects(dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }), /must not contain symlink components/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("new lanes require initial contract revision and distinct participant identities", async () => {
  const item = fixture();
  try {
    fs.writeFileSync(item.contractFile, "Context Revision: 2\n\nBuild it.\n");
    await assert.rejects(dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }), /new design lane requires Context Revision: 1/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }

  for (const [flag, value, error] of [
    ["--reviewer-session-id", "requester-1", /session ids must be distinct/],
    ["--reviewer-to-address", "waypost\/requester-1", /addresses must be distinct/]
  ]) {
    const lane = fixture();
    try {
      const args = [...lane.args];
      args[args.indexOf(flag) + 1] = value;
      await assert.rejects(dispatchDraft(args, {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }), error);
    } finally {
      fs.rmSync(lane.workdir, { recursive: true, force: true });
    }
  }
});

test("contract parser and TOML policy enforce simple human-editable inputs", () => {
  const item = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-workflow-policy-"));
  try {
    fs.writeFileSync(item.contractFile, "## Original Request\nBuild it.\n");
    assert.throws(() => readContract(item.contractFile), /Context Revision: 1/);

    const defaults = path.join(directory, "defaults.toml");
    const override = path.join(directory, "override.toml");
    fs.writeFileSync(defaults, "[tech_design.pruner]\nmax_lines = 250\nmax_chars = 20000\nrecheck_added_lines = 50\nrecheck_added_chars = 4000\n");
    fs.writeFileSync(override, "[tech_design.pruner]\nmax_lines = 300\n");
    assert.deepEqual(loadWorkflowPolicy({ paths: [defaults, override] }), {
      maxLines: 300,
      maxChars: 20000,
      recheckAddedLines: 50,
      recheckAddedChars: 4000
    });
    assert.deepEqual(parseWorkflowPolicyToml("[tech_design.pruner]\nrecheck_added_chars = 42\n"), {
      recheck_added_chars: 42
    });
    assert.throws(() => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_words = 10\n"), /invalid assignment/);
    assert.throws(() => parseWorkflowPolicyToml("[tech_design.pruner]\nmax_lines = 0\n"), /positive integer/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("design measurement counts nonempty lines and non-whitespace Unicode characters", () => {
  assert.deepEqual(measureDesign(" one \n\n二 三\n"), { lines: 2, chars: 5 });
  assert.deepEqual(measureGrowth("one\ntwo\n", "one revised\ntwo\nthree\n"), {
    addedLines: 1,
    addedChars: 12
  });
});

test("below-threshold review dispatch sends only reviewer and never changes manifest", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Small design\n\nDo one thing.\n");
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const stdout = await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
    assert.equal(hasStickyTaskContextMarker(records[0].body), false);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    assert.doesNotMatch(records[0].body, /SHA|Epoch|Gate/);
    const summary = JSON.parse(stdout);
    assert.deepEqual({
      status: summary.status,
      artifact: summary.artifact,
      round: summary.round,
      lines: summary.lines,
      chars: summary.chars,
      pruner_requested: summary.pruner_requested
    }, {
      status: "sent", artifact: expectedArtifactPath("author-1", 1), round: 1,
      lines: 2, chars: 23, pruner_requested: false
    });
    assert.equal(summary.reviewer_delivery_id, "delivery-1");
    assert.equal(summary.reviewer_notify_status, "sent");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("auto policy blocks before sending until an oversized design has a lazy pruner", async () => {
  const item = fixture();
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Design\n\nFirst material line.\nSecond material line.\n");
    const before = fs.readFileSync(item.manifestFile, "utf8");
    const blocked = [];
    await assert.rejects(dispatchReview(reviewArgs(item), {
      requireCommand() {},
      runWaypost: successfulWaypost(blocked),
      loadPolicy: () => ({ maxLines: 3, maxChars: 1000 })
    }), error => error.prefix === "PRUNER_REQUIRED" && error.exitCode === 3);
    assert.deepEqual(blocked, []);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);

    const records = [];
    await captureStdout(() => dispatchReview([
      ...reviewArgs(item),
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 3, maxChars: 1000 })
    }));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(records.some(record => hasStickyTaskContextMarker(record.body)), false);
    assert.equal(fs.readFileSync(item.manifestFile, "utf8"), before);
    for (const record of records) assert.doesNotMatch(record.body, /SHA|Epoch|Gate/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("auto policy skips pruner for minor fixes and rechecks cumulative growth from MINIMAL", async () => {
  const item = fixture();
  const policy = {
    maxLines: 3,
    maxChars: 1000,
    recheckAddedLines: 2,
    recheckAddedChars: 1000
  };
  try {
    await createLane(item);
    const baseline = writeArtifact(item, 1, "# Design\n\nOne.\nTwo.\n");
    await captureStdout(() => dispatchReview([
      ...reviewArgs(item),
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {}, runWaypost: successfulWaypost([]), loadPolicy: () => policy
    }));

    writeArtifact(item, 2, "# Design\n\nOne corrected.\nTwo.\n");
    const minorRecords = [];
    const minor = JSON.parse(await captureStdout(() => dispatchReview([
      ...reviewArgs(item, 2),
      "--pruner-baseline-artifact", baseline.relative
    ], {
      requireCommand() {}, runWaypost: successfulWaypost(minorRecords), loadPolicy: () => policy
    })));
    assert.deepEqual(minorRecords.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
    assert.equal(minor.added_lines_since_pruner, 0);
    assert.equal(minor.pruner_requested, false);

    writeArtifact(item, 3, "# Design\n\nOne corrected.\nTwo.\nThree.\nFour.\n");
    const blocked = [];
    const growthArgs = [
      ...reviewArgs(item, 3),
      "--pruner-baseline-artifact", baseline.relative
    ];
    await assert.rejects(dispatchReview(growthArgs, {
      requireCommand() {}, runWaypost: successfulWaypost(blocked), loadPolicy: () => policy
    }), error => error.prefix === "PRUNER_REQUIRED" && /cumulative content growth/.test(error.message));
    assert.deepEqual(blocked, []);

    const growthRecords = [];
    const growth = JSON.parse(await captureStdout(() => dispatchReview([
      ...growthArgs,
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {}, runWaypost: successfulWaypost(growthRecords), loadPolicy: () => policy
    })));
    assert.deepEqual(growthRecords.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(growth.added_lines_since_pruner, 2);
    assert.equal(growth.pruner_reason, "substantial cumulative content growth");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("auto policy rechecks declared major structure without treating minor edits as structure", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item);
    const baseline = writeArtifact(item, 1, "# Design\n\nOne.\nTwo.\n");
    writeArtifact(item, 2, "# Design\n\nTwo.\nOne.\n");
    const summary = JSON.parse(await captureStdout(() => dispatchReview([
      ...reviewArgs(item, 2),
      "--pruner-baseline-artifact", baseline.relative,
      "--major-structure-change",
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({
        maxLines: 10, maxChars: 1000, recheckAddedLines: 50, recheckAddedChars: 4000
      })
    })));
    assert.deepEqual(records.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(summary.pruner_reason, "major structural change");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("final pruner check forces exact-artifact pruning without repeating reviewer work", async () => {
  const item = fixture();
  const records = [];
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Small design\n");
    const summary = JSON.parse(await captureStdout(() => dispatchReview([
      ...reviewArgs(item),
      "--final-pruner-check",
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({
        maxLines: 250, maxChars: 20000, recheckAddedLines: 50, recheckAddedChars: 4000
      })
    })));
    assert.deepEqual(records.map(record => actionFrom(record.body)), ["design_prune_requested"]);
    assert.equal(summary.reviewer_requested, false);
    assert.equal(summary.pruner_requested, true);
    assert.equal(summary.pruner_reason, "final confirmation");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch retries a failed nudge inside the same invocation", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft(item.args, {
      requireCommand() {}, runWaypost: successfulWaypost([])
    }));
    writeArtifact(item, 1, "# Design\n");
    const sends = [];
    const nudges = [];
    const result = JSON.parse(await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {},
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 }),
      runWaypost(command, args, options) {
        sends.push({ command, args, body: options.input });
        return {
          status: 0,
          stdout: JSON.stringify({
            delivery_id: "review-delivery-1",
            notify_status: "failed",
            notify_error: "reviewer nudge failed"
          }),
          stderr: "",
          error: null,
          signal: null,
          timedOut: false
        };
      },
      runWaypostRead: waypostReadState("queued"),
      runNudge: successfulNudge(nudges)
    })));
    assert.deepEqual(sends.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);
    assert.equal(nudges.length, 1);
    assert.equal(result.reviewer_delivery_id, "review-delivery-1");
    assert.equal(result.reviewer_notify_status, "sent");
    assert.equal(result.reviewer_nudge_retry_count, 1);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("always and never policies deterministically override the threshold", async () => {
  for (const policy of ["always", "never"]) {
    const item = fixture();
    const records = [];
    try {
      const prunerArgs = policy === "always"
        ? ["--pruner-policy", "always", "--pruner-session-id", "pruner-1", "--pruner-to-address", "waypost/pruner-1"]
        : ["--pruner-policy", "never"];
      await captureStdout(() => dispatchDraft([...item.args, ...prunerArgs], {
        requireCommand() {}, runWaypost: successfulWaypost([])
      }));
      writeArtifact(item, 1, "# Design\n");
      await captureStdout(() => dispatchReview(reviewArgs(item), {
        requireCommand() {},
        runWaypost: successfulWaypost(records),
        loadPolicy: () => ({ maxLines: 1, maxChars: 1 })
      }));
      assert.deepEqual(records.map(record => actionFrom(record.body)), policy === "always"
        ? ["design_spec_review_requested", "design_prune_requested"]
        : ["design_spec_review_requested"]);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
    }
  }
});

test("always bypasses the initial size threshold without pruning every later round", async () => {
  const item = fixture();
  const policy = {
    maxLines: 250,
    maxChars: 20000,
    recheckAddedLines: 50,
    recheckAddedChars: 4000
  };
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-policy", "always",
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], { requireCommand() {}, runWaypost: successfulWaypost([]) }));

    const baseline = writeArtifact(item, 1, "# Small design\n\nOne.\n");
    const initialRecords = [];
    const initial = JSON.parse(await captureStdout(() => dispatchReview(reviewArgs(item), {
      requireCommand() {}, runWaypost: successfulWaypost(initialRecords), loadPolicy: () => policy
    })));
    assert.deepEqual(initialRecords.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(initial.pruner_reason, "initial no-threshold review");

    writeArtifact(item, 2, "# Small design\n\nOne corrected.\n");
    const minorRecords = [];
    await captureStdout(() => dispatchReview([
      ...reviewArgs(item, 2),
      "--pruner-baseline-artifact", baseline.relative
    ], {
      requireCommand() {}, runWaypost: successfulWaypost(minorRecords), loadPolicy: () => policy
    }));
    assert.deepEqual(minorRecords.map(record => actionFrom(record.body)), ["design_spec_review_requested"]);

    writeArtifact(item, 3, "# Small design\n\nOne corrected and reorganized.\n");
    const structuralRecords = [];
    await captureStdout(() => dispatchReview([
      ...reviewArgs(item, 3),
      "--pruner-baseline-artifact", baseline.relative,
      "--major-structure-change"
    ], {
      requireCommand() {}, runWaypost: successfulWaypost(structuralRecords), loadPolicy: () => policy
    }));
    assert.deepEqual(structuralRecords.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("never policy rejects a final pruner check", async () => {
  const item = fixture();
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-policy", "never"
    ], { requireCommand() {}, runWaypost: successfulWaypost([]) }));
    writeArtifact(item, 1, "# Design\n");
    await assert.rejects(dispatchReview([
      ...reviewArgs(item),
      "--final-pruner-check"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost([]),
      loadPolicy: () => ({
        maxLines: 1, maxChars: 1, recheckAddedLines: 1, recheckAddedChars: 1
      })
    }), /explicitly waives final pruner confirmation/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review text output reports an enabled pruner nudge failure", async () => {
  const item = fixture();
  const sends = [];
  const nudges = [];
  try {
    await captureStdout(() => dispatchDraft([
      ...item.args,
      "--pruner-policy", "always",
      "--pruner-session-id", "pruner-1",
      "--pruner-to-address", "waypost/pruner-1"
    ], {
      requireCommand() {},
      runWaypost: successfulWaypost([])
    }));
    writeArtifact(item, 1, "# Design\n");
    const stdout = await captureStdout(() => dispatchReview(
      reviewArgs(item).filter(argument => argument !== "--json"),
      {
        requireCommand() {},
        loadPolicy: () => ({ maxLines: 250, maxChars: 20000 }),
        runWaypost: waypostWithFailedPrunerNudge(sends),
        runWaypostRead: waypostReadState("queued"),
        runNudge: failedNudge(nudges)
      }
    ));
    assert.deepEqual(sends.map(record => record.action), [
      "design_spec_review_requested", "design_prune_requested"
    ]);
    assert.equal(nudges.length, 1);
    assert.match(stdout, /pruner_delivery_id=delivery-2/);
    assert.match(stdout, /pruner_notify_status=failed/);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch validates exact round, previous artifact, and contract revision", async () => {
  const item = fixture();
  try {
    await createLane(item);
    writeArtifact(item, 1, "# Round one\n");
    writeArtifact(item, 2, "# Round two\n");
    const wrongPrevious = reviewArgs(item, 2);
    wrongPrevious[wrongPrevious.indexOf("--previous-artifact") + 1] = expectedArtifactPath("author-1", 0);
    await assert.rejects(dispatchReview(wrongPrevious, {
      requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), /--previous-artifact must equal/);

    const wrongRevision = reviewArgs(item, 2);
    wrongRevision[wrongRevision.indexOf("--context-revision") + 1] = "2";
    await assert.rejects(dispatchReview(wrongRevision, {
      requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), /does not match the Canonical Contract/);

    const records = [];
    await captureStdout(() => dispatchReview(reviewArgs(item, 2), {
      requireCommand() {},
      runWaypost: successfulWaypost(records),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }));
    assert.match(records[0].body, /^Previous Artifact: \.agent-artifacts\/design-spec\/author-1\/r001\.md$/m);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("continued review schedules checkpoints every two rounds", async () => {
  const item = fixture();
  try {
    await createLane(item);
    writeArtifact(item, 5, "# Round five\n");
    writeArtifact(item, 6, "# Round six\n");
    writeArtifact(item, 7, "# Round seven\n");
    writeArtifact(item, 8, "# Round eight\n");
    const blocked = [];
    await assert.rejects(dispatchReview(reviewArgs(item, 6), {
      requireCommand() {},
      runWaypost: successfulWaypost(blocked),
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), error => error.prefix === "USER_CHECKPOINT_REQUIRED" && error.exitCode === 3);
    assert.deepEqual(blocked, []);

    const contractBefore = fs.readFileSync(item.contractFile, "utf8");
    await captureStdout(() => advanceReviewCheckpoint([
      "--workdir", item.workdir,
      "--lane-manifest", item.manifestRelative,
      "--expected-current-checkpoint", "5",
      "--json"
    ]));
    const manifest = JSON.parse(fs.readFileSync(item.manifestFile, "utf8"));
    assert.equal(manifest.review_checkpoint, 7);
    assert.equal(manifest.review_checkpoint_interval, 2);
    assert.equal(fs.readFileSync(item.contractFile, "utf8"), contractBefore);

    const reviews = [];
    for (const round of [6, 7]) {
      await captureStdout(() => dispatchReview(reviewArgs(item, round), {
        requireCommand() {},
        runWaypost: successfulWaypost(reviews),
        loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
      }));
    }
    assert.deepEqual(reviews.map(record => actionFrom(record.body)), [
      "design_spec_review_requested", "design_spec_review_requested"
    ]);

    const nextBlocked = reviewArgs(item, 8);
    await assert.rejects(dispatchReview(nextBlocked, {
      requireCommand() {},
      loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
    }), error => error.prefix === "USER_CHECKPOINT_REQUIRED");
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("checkpoint advance rejects stale compare-and-set input", async () => {
  const item = fixture();
  try {
    await createLane(item);
    await captureStdout(() => advanceReviewCheckpoint([
      "--workdir", item.workdir,
      "--lane-manifest", item.manifestRelative,
      "--expected-current-checkpoint", "5"
    ]));
    await assert.rejects(advanceReviewCheckpoint([
      "--workdir", item.workdir,
      "--lane-manifest", item.manifestRelative,
      "--expected-current-checkpoint", "5"
    ]), /checkpoint changed/);
    assert.equal(JSON.parse(fs.readFileSync(item.manifestFile, "utf8")).review_checkpoint, 7);
  } finally {
    fs.rmSync(item.workdir, { recursive: true, force: true });
  }
});

test("review dispatch rejects symlinked manifest and artifact parents", async () => {
  for (const target of ["manifest", "artifact"]) {
    const item = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), `agentgear-design-${target}-external-`));
    try {
      await createLane(item);
      const { artifact } = writeArtifact(item, 1, "# Design\n");
      const source = target === "manifest"
        ? path.join(item.workdir, ".agent-artifacts", "design-spec-dispatch")
        : path.dirname(artifact);
      const moved = path.join(external, path.basename(source));
      fs.renameSync(source, moved);
      fs.symlinkSync(moved, source, "dir");
      await assert.rejects(dispatchReview(reviewArgs(item), {
        requireCommand() {}, loadPolicy: () => ({ maxLines: 250, maxChars: 20000 })
      }), /must not contain symlink components/);
    } finally {
      fs.rmSync(item.workdir, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }
});
