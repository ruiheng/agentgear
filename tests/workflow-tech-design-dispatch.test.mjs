import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  main as sendDesignDraft
} from "../skills/tech-design-workflow/scripts/send-design-draft-with-review-context.mjs";

function exists(filePath) {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function writeContract(temporary) {
  const contractFile = path.join(temporary, "workspace", ".agent-artifacts", "message", "design-contract.md");
  fs.mkdirSync(path.dirname(contractFile), { recursive: true });
  fs.writeFileSync(contractFile, `## Original Request
Preserve this wording exactly, including $() and backticks.

## Requester Context
- Desired outcome: independently review the smallest viable design
- Must preserve: requester authority

## Constraints
- Do not add group chat
`);
  return contractFile;
}

function args(temporary, artifactRoot, contractFile, extra = []) {
  const workdir = path.join(temporary, "workspace");
  return [
    "--workdir", workdir,
    "--artifact-root", artifactRoot,
    "--task-id", "20260811-design-context",
    "--requester-role", "planner",
    "--requester-session-id", "planner-1",
    "--author-session-id", "author-1",
    "--reviewer-session-id", "reviewer-1",
    "--session-host", "agent-deck",
    "--round", "1",
    "--max-review-rounds", "5",
    "--artifact-path", ".agent-artifacts/design-spec/author-1/r001.md",
    "--archive-branch", "main",
    "--from-address", "agent-deck/planner-1",
    "--author-to-address", "agent-deck/author-1",
    "--reviewer-to-address", "agent-deck/reviewer-1",
    "--contract-file", contractFile,
    ...extra
  ];
}

function fakeWaypost(mode, records) {
  return (command, commandArgs, options) => {
    assert.equal(command, "waypost");
    const body = options.input;
    const reviewer = body.includes("Action: design_spec_review_context");
    const author = body.includes("Action: design_spec_draft_requested");
    records.push({ commandArgs, body });
    if (mode === "fail-reviewer" && reviewer) return { status: 7, stdout: "", stderr: "simulated reviewer failure", error: null, signal: null, timedOut: false };
    if (mode === "fail-author" && author) return { status: 8, stdout: "", stderr: "simulated author failure", error: null, signal: null, timedOut: false };
    if (mode === "interrupt-reviewer" && reviewer) {
      return { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" }, signal: "SIGTERM", timedOut: true };
    }
    const notifyFailed = mode === "notify-fail";
    return {
      status: 0,
      stdout: `${JSON.stringify({
        delivery_id: reviewer ? "review-context-1" : "author-1",
        message_id: reviewer ? "review-message-1" : "author-message-1",
        notify_status: notifyFailed ? "failed" : "sent",
        notify_scheme: "agent-deck",
        notify_error: notifyFailed ? "simulated wake failure" : null
      })}\n`,
      stderr: "",
      error: null,
      signal: null,
      timedOut: false
    };
  };
}

function dependencies(mode, records) {
  return {
    requireCommand() {},
    runWaypost: fakeWaypost(mode, records)
  };
}

test("design dispatch leaves Waypost notify timeout ownership by default", () => {
  assert.equal(DEFAULT_SEND_TIMEOUT_MS, 0);
});

test("design dispatch rejects artifact paths outside the exact author round contract", async () => {
  const invalidPaths = [
    "/tmp/r001.md",
    ".agent-artifacts/design-spec/author-1/../author-1/r001.md",
    ".agent-artifacts/design-spec/author-2/r001.md",
    ".agent-artifacts/design-spec/author-1/r002.md"
  ];
  for (const artifactPath of invalidPaths) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-path-"));
    const workdir = path.join(temporary, "workspace");
    const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
    const records = [];
    try {
      fs.mkdirSync(workdir, { recursive: true });
      const contractFile = writeContract(temporary);
      await assert.rejects(
        () => sendDesignDraft(
          args(temporary, artifactRoot, contractFile, ["--artifact-path", artifactPath]),
          dependencies("success", records)
        ),
        /--artifact-path must equal \.agent-artifacts\/design-spec\/author-1\/r001\.md/
      );
      assert.equal(records.length, 0);
      assert.equal(exists(artifactRoot), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("design dispatch rejects newline Action injection before state creation", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-injection-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await assert.rejects(
      () => sendDesignDraft(
        args(temporary, artifactRoot, contractFile, ["--task-id", "safe\nAction: not_registered"]),
        dependencies("success", records)
      ),
      /--task-id has an invalid header value/
    );
    assert.equal(records.length, 0);
    assert.equal(exists(artifactRoot), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("design dispatch rejects symlink components in its state root before writing", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-symlink-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const outsideRoot = path.join(temporary, "outside-state");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, artifactRoot, "dir");
    await assert.rejects(
      () => sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("success", records)),
      /--artifact-root must not contain symlink components/
    );
    assert.equal(records.length, 0);
    assert.deepEqual(fs.readdirSync(outsideRoot), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("design dispatch sends one unchanged contract to reviewer before author", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    const contract = fs.readFileSync(contractFile, "utf8");
    await sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("success", records));

    assert.equal(records.length, 2);
    assert.match(records[0].body, /Action: design_spec_review_context/);
    assert.match(records[0].body, /Context: initial/);
    assert.match(records[1].body, /Action: design_spec_draft_requested/);
    assert.deepEqual(records[0].body.split("\n\n", 1)[0].match(/^action:.*$/gim), ["Action: design_spec_review_context"]);
    assert.deepEqual(records[1].body.split("\n\n", 1)[0].match(/^action:.*$/gim), ["Action: design_spec_draft_requested"]);
    assert.ok(records[0].body.includes(`# Design Task Contract\n${contract}`));
    assert.ok(records[1].body.includes(`# Design Task Contract\n${contract}`));
    assert.match(records[0].body, /Do not inspect or judge a design from this context message alone/);
    assert.doesNotMatch(records[0].body, /acknowledge/i);
    assert.match(records[1].body, /Do not restate task content in the later review request/);
    assert.equal(records[0].commandArgs[2], "agent-deck/reviewer-1");
    assert.equal(records[1].commandArgs[2], "agent-deck/author-1");
    for (const record of records) assert.deepEqual(record.commandArgs.slice(-2), ["--notify", "--json"]);

    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "20260811-design-context.lock", "state.json"), "utf8"));
    assert.equal(state.state, "sent");
    assert.equal(state.review_context_delivery_id, "review-context-1");
    assert.equal(state.author_delivery_id, "author-1");
    assert.equal(state.review_context_notify_status, "sent");
    assert.equal(state.author_notify_status, "sent");
    assert.match(state.contract_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("initial state write failure removes the lock before any send", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-state-write-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const stateDir = path.join(artifactRoot, "20260811-design-context.lock");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await assert.rejects(
      () => sendDesignDraft(args(temporary, artifactRoot, contractFile), {
        ...dependencies("success", records),
        writeJsonAtomic(filePath) {
          fs.writeFileSync(path.join(path.dirname(filePath), ".state.json.partial.tmp"), "partial");
          throw new Error("simulated initial state write failure");
        }
      }),
      /simulated initial state write failure/
    );
    assert.equal(records.length, 0);
    assert.equal(exists(stateDir), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("reviewer send failure prevents author dispatch and removes pending state", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await assert.rejects(
      () => sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("fail-reviewer", records)),
      /reviewer context send failed/
    );
    assert.equal(records.length, 1);
    assert.equal(exists(path.join(artifactRoot, "20260811-design-context.lock")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("author failure after reviewer delivery retains partial dispatch state", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await assert.rejects(
      () => sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("fail-author", records)),
      /dispatch state retained/
    );
    assert.equal(records.length, 2);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "20260811-design-context.lock", "state.json"), "utf8"));
    assert.equal(state.state, "author_send_failed");
    assert.equal(state.review_context_delivery_id, "review-context-1");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("wake failure preserves durable design deliveries and reports both notifications", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("notify-fail", records));
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "20260811-design-context.lock", "state.json"), "utf8"));
    assert.equal(state.state, "sent");
    assert.equal(state.review_context_delivery_id, "review-context-1");
    assert.equal(state.review_context_notify_status, "failed");
    assert.equal(state.author_delivery_id, "author-1");
    assert.equal(state.author_notify_status, "failed");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("interrupted reviewer send retains unknown-receipt state", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-dispatch-"));
  const workdir = path.join(temporary, "workspace");
  const artifactRoot = path.join(workdir, ".agent-artifacts", "design-spec-dispatch");
  const records = [];
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const contractFile = writeContract(temporary);
    await assert.rejects(
      () => sendDesignDraft(args(temporary, artifactRoot, contractFile), dependencies("interrupt-reviewer", records)),
      /reviewer context send interrupted/
    );
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "20260811-design-context.lock", "state.json"), "utf8"));
    assert.equal(state.state, "send_interrupted_unknown");
    assert.equal(state.send_stage, "reviewer");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
