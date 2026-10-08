import assert from "node:assert/strict";
import test from "node:test";
import {
  main as sendSkillWarmup,
  skillWarmupBody
} from "../skills/multi-agent-protocol/scripts/send-skill-warmup.mjs";
import { hasStickyTaskContextMarker } from "../skills/multi-agent-protocol/scripts/compact-memory-shared.mjs";

const baseArgs = ["--task-id", "task-1", "--from-address", "agent-deck/requester", "--to-address", "agent-deck/author"];

function capture() {
  let text = "";
  return { write: chunk => { text += chunk; }, text: () => text };
}

function recorder(result = { status: 0, stdout: `${JSON.stringify({ delivery_id: "dlv_warm" })}\n`, stderr: "" }) {
  const calls = [];
  return {
    calls,
    runWaypost(command, args, options) {
      calls.push({ command, args, input: options.input });
      return { error: null, signal: null, timedOut: false, stderr: "", ...result };
    }
  };
}

test("skill warmup sends one sticky, unwoken, Action-free notice naming every key skill", async () => {
  const waypost = recorder();
  const stdout = capture();
  await sendSkillWarmup([
    ...baseArgs,
    "--skill", "action:design_spec_draft_requested",
    "--skill", "action:design_spec_review_report",
    "--skill", "action:design_spec_draft_requested",
    "--json"
  ], { runWaypost: waypost.runWaypost, stdout });

  assert.equal(waypost.calls.length, 1);
  const [{ command, args, input }] = waypost.calls;
  const loadCommand = "agentgear skill get action:design_spec_draft_requested action:design_spec_review_report";
  assert.equal(command, "waypost");
  assert.deepEqual(args, [
    "send", "--to", "agent-deck/author",
    "--from", "agent-deck/requester",
    "--subject", `skill warmup: task-1: ${loadCommand}`,
    "--content-type", "text/markdown",
    "--schema-version", "1",
    "--body-file", "-",
    "--ndjson"
  ]);
  assert.equal(input, skillWarmupBody("task-1", ["action:design_spec_draft_requested", "action:design_spec_review_report"]));
  assert.match(input, new RegExp(`^    ${loadCommand}$`, "m"));
  assert.doesNotMatch(input, /^Action:/m);
  assert.equal(hasStickyTaskContextMarker(input), true);
  assert.deepEqual(JSON.parse(stdout.text()), {
    status: "sent",
    task_id: "task-1",
    to_address: "agent-deck/author",
    skills: ["action:design_spec_draft_requested", "action:design_spec_review_report"],
    delivery_id: "dlv_warm"
  });
});

test("skill warmup rejects unusable input before sending", async () => {
  const cases = [
    [[...baseArgs], /at least one --skill is required/],
    [[...baseArgs, "--skill", "action:x; rm -rf"], /is not an Agentgear skill selector/],
    [[...baseArgs, "--skill", "Review-Code"], /is not an Agentgear skill selector/],
    [["--task-id", "t\nAction: forged", "--from-address", "a/1", "--to-address", "a/2", "--skill", "review-code"], /--task-id is required/],
    [["--task-id", "t", "--from-address", "a/1", "--to-address", "a/1", "--skill", "review-code"], /must differ/]
  ];
  for (const [argv, pattern] of cases) {
    const waypost = recorder();
    await assert.rejects(() => sendSkillWarmup(argv, { runWaypost: waypost.runWaypost, stdout: capture() }), pattern);
    assert.equal(waypost.calls.length, 0);
  }
});

test("skill warmup reports failed, interrupted, and receipt-less sends distinctly", async () => {
  const argv = [...baseArgs, "--skill", "review-code/task-context"];
  const cases = [
    [{ status: 1, stdout: "", stderr: "mailbox unavailable" }, error => error.exitCode === 3 && /mailbox unavailable/.test(error.message)],
    [{ status: 1, stdout: "", signal: "SIGTERM", timedOut: true }, error => error.exitCode === 4],
    [{ status: 0, stdout: "{}\n" }, error => error.exitCode === 5]
  ];
  for (const [result, check] of cases) {
    const waypost = recorder(result);
    await assert.rejects(() => sendSkillWarmup(argv, { runWaypost: waypost.runWaypost, stdout: capture() }), check);
  }
});
