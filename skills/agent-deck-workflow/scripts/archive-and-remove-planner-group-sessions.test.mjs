import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, "archive-and-remove-planner-group-sessions.mjs");
const childProcessesAvailable = !childProcess.spawnSync(process.execPath, ["--version"], { encoding: "utf8" }).error;
const integrationTest = childProcessesAvailable ? test : test.skip;

const fakeAgentDeck = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.ADWG_TEST_STATE_FILE;
const groupsFile = process.env.ADWG_TEST_GROUPS_FILE;
const argv = process.argv.slice(2);
if (!stateFile || !groupsFile) process.exit(2);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const findGroup = (groups, target) => {
  for (const group of groups || []) {
    if (group.path === target) return group;
    const found = findGroup(group.children, target);
    if (found) return found;
  }
  return null;
};
const removeGroup = (groups, target) => {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index].path === target) { groups.splice(index, 1); return true; }
    if (removeGroup(groups[index].children || [], target)) return true;
  }
  return false;
};
let args = argv;
if (args[0] === "-p") args = args.slice(2);
const state = read(stateFile);
if (args[0] === "list") { process.stdout.write(JSON.stringify(state.sessions)); process.exit(0); }
if (args[0] === "session" && args[1] === "show") {
  const session = state.sessions.find(item => item.id === args[2] || item.title === args[2]);
  if (!session) process.exit(1);
  process.stdout.write(JSON.stringify(session)); process.exit(0);
}
if (args[0] === "remove") {
  const index = state.sessions.findIndex(item => item.id === args[1]);
  if (index < 0) process.exit(1);
  state.sessions.splice(index, 1); write(stateFile, state); process.exit(0);
}
if (args[0] === "group" && args[1] === "list") { process.stdout.write(fs.readFileSync(groupsFile, "utf8")); process.exit(0); }
if (args[0] === "group" && args[1] === "delete") {
  const groups = read(groupsFile);
  if (!removeGroup(groups.groups, args[2])) process.exit(1);
  write(groupsFile, groups); process.exit(0);
}
process.exit(2);
`;

function containsGroup(groups, targetPath) {
  for (const group of groups || []) {
    if (group.path === targetPath || containsGroup(group.children, targetPath)) return true;
  }
  return false;
}

function setup({ sessions, groups }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "adwf-planner-group-test-"));
  const work = path.join(temporary, "work");
  const bin = path.join(temporary, "bin");
  const stateFile = path.join(temporary, "state.json");
  const groupsFile = path.join(temporary, "groups.json");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ sessions }));
  fs.writeFileSync(groupsFile, JSON.stringify({ groups }));
  const command = path.join(bin, "agent-deck");
  fs.writeFileSync(command, fakeAgentDeck);
  fs.chmodSync(command, 0o755);
  const run = argumentsList => childProcess.spawnSync(process.execPath, [target, ...argumentsList], {
    cwd: work,
    env: {
      ...process.env,
      ADWG_TEST_STATE_FILE: stateFile,
      ADWG_TEST_GROUPS_FILE: groupsFile,
      PATH: bin + path.delimiter + (process.env.PATH || "")
    },
    encoding: "utf8"
  });
  return { temporary, stateFile, groupsFile, run };
}

integrationTest("planner cleanup uses only its live fallback subgroup and preserves siblings", () => {
  const fixture = setup({
    sessions: [
      { id: "super-1", title: "supervisor", group: "real/scope", parent_session_id: "", path: "/tmp/s", status: "waiting" },
      { id: "planner-1", title: "planner-x", group: "real/scope", parent_session_id: "super-1", path: "/tmp/p", status: "waiting" },
      { id: "coder-1", title: "coder", group: "real/scope", parent_session_id: "", path: "/tmp/c", status: "waiting" }
    ],
    groups: [{ name: "real", path: "real", children: [{ name: "scope", path: "real/scope", children: [{ name: "planner-x", path: "real/scope/planner-x", children: [] }] }] }]
  });
  try {
    const result = fixture.run(["--planner-session-id", "planner-1", "--apply"]);
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.match(result.stdout, /planner_group_cleanup planner_group=real\/scope/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["super-1", "coder-1"]);
    assert.equal(containsGroup(JSON.parse(fs.readFileSync(fixture.groupsFile, "utf8")).groups, "real/scope/planner-x"), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("missing live planner does not trust stale archive scope", () => {
  const fixture = setup({
    sessions: [{ id: "coder-1", title: "coder", group: "legacy/scope", parent_session_id: "", path: "/tmp/c", status: "waiting" }],
    groups: [{ name: "legacy", path: "legacy", children: [{ name: "scope", path: "legacy/scope", children: [] }] }]
  });
  try {
    const result = fixture.run(["--planner-session-id", "planner-1", "--apply"]);
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.match(result.stdout, /group_delete_status=not_applicable/);
    assert.match(result.stdout, /planner session not found; planner lane cleanup scope unavailable/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.length, 1);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("obsolete group hint argument is rejected", () => {
  const fixture = setup({ sessions: [], groups: [] });
  try {
    const result = fixture.run(["--planner-session-id", "planner-1", "--planner-group-hint", "legacy/scope"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr || result.stdout || result.error?.message || "", /unknown arg: --planner-group-hint/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
