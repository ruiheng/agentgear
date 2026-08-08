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
  "coordinate-design-spec",
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
