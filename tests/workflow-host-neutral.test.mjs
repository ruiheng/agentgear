import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

const creationSkills = [
  "delegate-code-task",
  "delegate-task",
  "dispatch-plan",
  "review-request",
  "refactor-review-request",
  "browser-test-request",
  "tech-design-workflow",
  "roundtable",
];

test("generic creation skills do not embed Agent Deck routing", () => {
  for (const name of creationSkills) {
    const source = read(`skills/${name}/SKILL.md`);
    assert.match(source, /session_(?:resolve|require|create)|session-host/);
    assert.doesNotMatch(source, /agent_deck_(?:create|require|resolve)_session/);
    assert.doesNotMatch(source, /agent-deck\//);
    assert.doesNotMatch(source, /\bensure_cmd\b/);
    assert.doesNotMatch(source, /\bgroup_path\b/);
    assert.doesNotMatch(source, /\bstartup_instruction\b/);
  }
});

test("the shared contract uses resolver-provided launch values", () => {
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  const resolverContract = read("skills/multi-agent-protocol/references/tool-resolution.md");
  assert.match(hostContract, /full_command_line/);
  assert.match(hostContract, /thurbox_agent_key/);
  assert.doesNotMatch(hostContract, /launch_profile/);
  assert.doesNotMatch(hostContract, /session-host-config/);
  assert.match(resolverContract, /tool_candidates/);
  assert.match(resolverContract, /thurbox_agent_key/);
});

test("the shared contract does not auto-repair unverified wake hints", () => {
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  const sharedProtocol = read("skills/multi-agent-protocol/references/internal-protocol/shared-protocol.md");
  for (const source of [hostContract, sharedProtocol]) {
    assert.match(source, /false\s+negative/);
    assert.match(source, /Do not resend, press\s+Enter, restart, inspect, or (?:otherwise )?repair/);
    assert.match(source, /explicitly\s+authorizes troubleshooting/);
  }
});

test("generic workflow scripts require explicit Waypost routes", () => {
  for (const name of [
    "acquire-active-task-lock.mjs",
    "send-delegate-with-active-task-lock.mjs",
    "prepare-workspaces.mjs",
    "planner-closeout-batch.mjs",
  ]) {
    const source = read(`skills/multi-agent-protocol/scripts/${name}`);
    assert.doesNotMatch(source, /\bagent-deck\b/);
  }
  const sender = read("skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs");
  assert.match(sender, /--from-address/);
  assert.match(sender, /--to-address/);
});

test("closeout documents exact task-session cleanup ownership", () => {
  const plannerCloseout = read("skills/planner-closeout/SKILL.md");
  const delegateCode = read("skills/delegate-code-task/SKILL.md");
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  assert.match(plannerCloseout, /--coder-session-id <coder_session_id>/);
  assert.match(plannerCloseout, /--reviewer-session-id <reviewer_session_id>/);
  assert.match(plannerCloseout, /--session-host <session_host>/);
  assert.match(delegateCode, /task-scoped coder/);
  assert.match(hostContract, /exact recorded ids/);
  assert.doesNotMatch(plannerCloseout, /Generic workflow code does not remove or rehome host sessions/);
});
