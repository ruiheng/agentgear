import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveScript = path.join(rootDir, "skills/multi-agent-protocol/scripts/archive-and-remove-task-sessions.mjs");
const closeoutScript = path.join(rootDir, "skills/multi-agent-protocol/scripts/planner-closeout-batch.mjs");
const childProcessesAvailable = !childProcess.spawnSync(process.execPath, ["--version"], { encoding: "utf8" }).error
  && !childProcess.spawnSync("git", ["--version"], { encoding: "utf8" }).error;
const integrationTest = childProcessesAvailable ? test : test.skip;

const fakeAgentDeck = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.ADWF_TEST_SESSION_STATE;
const failRemove = process.env.ADWF_TEST_FAIL_REMOVE || "";
let args = process.argv.slice(2);
if (args[0] === "-p") args = args.slice(2);
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const write = value => fs.writeFileSync(stateFile, JSON.stringify(value));
const state = read();
if (args[0] === "session" && args[1] === "current") {
  process.stdout.write(JSON.stringify(state.sessions.find(session => session.current) || {}));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "show") {
  const session = state.sessions.find(item => item.id === args[2] || item.title === args[2]);
  if (!session) process.exit(1);
  process.stdout.write(JSON.stringify(session));
  process.exit(0);
}
if (args[0] === "remove") {
  if (args[1] === failRemove) { process.stderr.write("remove failed for test\\n"); process.exit(1); }
  const index = state.sessions.findIndex(item => item.id === args[1]);
  if (index < 0) process.exit(1);
  state.sessions.splice(index, 1);
  write(state);
  process.exit(0);
}
if (args[0] === "list") {
  process.stdout.write(JSON.stringify(state.sessions));
  process.exit(0);
}
if (args[0] === "group" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ groups: [] }));
  process.exit(0);
}
process.exit(2);
`;

const fakeThurbox = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.ADWF_TEST_SESSION_STATE;
const failDelete = process.env.ADWF_TEST_FAIL_REMOVE || "";
const args = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const write = value => fs.writeFileSync(stateFile, JSON.stringify(value));
const state = read();
if (args[0] === "session" && args[1] === "get") {
  const session = state.sessions.find(item => item.id === args[2] || item.uuid === args[2]);
  if (!session) process.exit(1);
  process.stdout.write(JSON.stringify(session));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  if (args.includes("--force")) process.exit(8);
  if (args[2] === failDelete) { process.stderr.write("thurbox delete failed for test\\n"); process.exit(7); }
  const index = state.sessions.findIndex(item => item.id === args[2] || item.uuid === args[2]);
  if (index < 0) process.exit(1);
  state.sessions.splice(index, 1);
  write(state);
  process.stdout.write(JSON.stringify({ status: "deleted" }));
  process.exit(0);
}
process.exit(2);
`;

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function makeFixture(sessions) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-closeout-test-"));
  const bin = path.join(temporary, "bin");
  const stateFile = path.join(temporary, "sessions.json");
  const xdgDataHome = path.join(temporary, "xdg-data");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ sessions }));
  const agentDeck = path.join(bin, "agent-deck");
  fs.writeFileSync(agentDeck, fakeAgentDeck);
  fs.chmodSync(agentDeck, 0o755);
  const thurbox = path.join(bin, "thurbox-cli");
  fs.writeFileSync(thurbox, fakeThurbox);
  fs.chmodSync(thurbox, 0o755);
  return {
    temporary,
    stateFile,
    xdgDataHome,
    env: {
      ...process.env,
      ADWF_NOTIFY: "off",
      ADWF_TEST_SESSION_STATE: stateFile,
      HOME: temporary,
      XDG_DATA_HOME: xdgDataHome,
      PATH: bin + path.delimiter + (process.env.PATH || "")
    }
  };
}

function initCloseoutRepository(temporary, taskId) {
  const repository = path.join(temporary, "repository");
  fs.mkdirSync(repository, { recursive: true });
  assert.equal(run("git", ["init", "-b", "main"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["config", "user.email", "test@example.invalid"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["config", "user.name", "Agentgear Test"], { cwd: repository }).status, 0);
  fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
  assert.equal(run("git", ["add", "base.txt"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["commit", "-m", "base"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["switch", "-c", `task/${taskId}`], { cwd: repository }).status, 0);
  fs.writeFileSync(path.join(repository, "task.txt"), "task\n");
  assert.equal(run("git", ["add", "task.txt"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["commit", "-m", "task"], { cwd: repository }).status, 0);
  assert.equal(run("git", ["switch", "main"], { cwd: repository }).status, 0);
  const artifactRoot = path.join(repository, ".agent-artifacts");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "planner-workspace.json"), `${JSON.stringify({
    planner_session_id: "planner-1",
    integration_branch: "main",
    worker_workspace: fs.realpathSync(repository),
    planner_workspace: fs.realpathSync(repository)
  }, null, 2)}\n`);
  return { repository, artifactRoot };
}

integrationTest("task-session cleanup limits deletion to explicitly supplied roles", () => {
  const taskId = "20260809-1200-explicit";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "coder-1", title: `coder-${taskId}`, tool: "shell", group: "" },
    { id: "reviewer-1", title: `reviewer-${taskId}`, tool: "shell", group: "" }
  ]);
  try {
    const result = run(process.execPath, [archiveScript, "--task-id", taskId, "--planner-session-id", "planner-1", "--coder-session-id", "coder-1", "--artifact-root", path.join(fixture.temporary, "artifacts"), "--apply"], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["planner-1", "reviewer-1"]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup reads provider ids from Agent Deck's XDG hook data", () => {
  const taskId = "20260809-1200-xdg-provider-id";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "coder-1", title: `coder-${taskId}`, tool: "codex", group: "" }
  ]);
  try {
    const hookDirectory = path.join(fixture.xdgDataHome, "agent-deck", "hooks");
    fs.mkdirSync(hookDirectory, { recursive: true });
    fs.writeFileSync(path.join(hookDirectory, "coder-1.json"), JSON.stringify({ session_id: "019fe-test-provider" }));
    const legacyHookDirectory = path.join(fixture.temporary, ".agent-deck", "hooks");
    fs.mkdirSync(legacyHookDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyHookDirectory, "coder-1.json"), JSON.stringify({ session_id: "stale-legacy-provider" }));
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--planner-session-id", "planner-1",
      "--coder-session-id", "coder-1",
      "--artifact-root", path.join(fixture.temporary, "artifacts"),
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["planner-1"]);
    const archive = JSON.parse(fs.readFileSync(path.join(fixture.temporary, "artifacts", taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].provider_resume_ids.codex_session_id, "019fe-test-provider");
    assert.equal(archive.sessions[0].provider_resume_source, "hook_status_file");
    assert.equal(archive.sessions[0].delete_status, "deleted");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup reports a failed Agent Deck removal", () => {
  const taskId = "20260809-1201-remove-failure";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "coder-1", title: `coder-${taskId}`, tool: "shell", group: "" }
  ]);
  try {
    const result = run(process.execPath, [archiveScript, "--task-id", taskId, "--planner-session-id", "planner-1", "--coder-session-id", "coder-1", "--artifact-root", path.join(fixture.temporary, "artifacts"), "--apply"], {
      env: { ...fixture.env, ADWF_TEST_FAIL_REMOVE: "coder-1" }
    });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_failed count=1/);
    const archive = JSON.parse(fs.readFileSync(path.join(fixture.temporary, "artifacts", taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_error.exit_code, 1);
    assert.equal(archive.sessions[0].delete_error.message, "remove failed for test");
    assert.equal(archive.sessions[0].delete_provider.stderr, "remove failed for test\n");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup preserves an explicitly reusable session", () => {
  const taskId = "20260809-1202-reusable";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "coder-reusable", title: "shared-coder", tool: "shell", group: "" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [archiveScript, "--task-id", taskId, "--planner-session-id", "planner-1", "--coder-session-id", "coder-reusable", "--artifact-root", artifactRoot, "--apply"], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_status=skipped_non_disposable_session/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["planner-1", "coder-reusable"]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_status, "skipped_non_disposable_session");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("planner closeout removes exact Agent Deck coder and reviewer sessions", () => {
  const taskId = "20260809-1202-closeout";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "coder-1", title: `coder-${taskId}`, tool: "shell", group: "" },
    { id: "reviewer-1", title: `reviewer-task-planner-1-${taskId}`, tool: "shell", group: "" }
  ]);
  try {
    const { repository, artifactRoot } = initCloseoutRepository(fixture.temporary, taskId);
    const result = run(process.execPath, [
      closeoutScript,
      "--task-id", taskId,
      "--task-branch", `task/${taskId}`,
      "--integration-branch", "main",
      "--worker-workspace", repository,
      "--planner-workspace", repository,
      "--task-dir", repository,
      "--planner-session-id", "planner-1",
      "--session-host", "agent-deck",
      "--coder-session-id", "coder-1",
      "--reviewer-session-id", "reviewer-1"
    ], { cwd: repository, env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /planner_closeout_ok /);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["planner-1"]);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "workflow-progress", `closeout-state-${taskId}.json`), "utf8"));
    assert.equal(state.optional_actions.session_cleanup, "complete");
    assert.equal(fs.existsSync(path.join(artifactRoot, "planner-workspace.json")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("planner closeout soft-deletes disposable Thurbox sessions", () => {
  const taskId = "20260809-1203-thurbox";
  const fixture = makeFixture([
    { uuid: "thurbox-coder", name: `coder-${taskId}`, repo_path: "/tmp/work", parent: "planner-1" }
  ]);
  try {
    const { repository, artifactRoot } = initCloseoutRepository(fixture.temporary, taskId);
    const result = run(process.execPath, [
      closeoutScript,
      "--task-id", taskId,
      "--task-branch", `task/${taskId}`,
      "--integration-branch", "main",
      "--worker-workspace", repository,
      "--planner-workspace", repository,
      "--task-dir", repository,
      "--planner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--coder-session-id", "thurbox-coder"
    ], { cwd: repository, env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /planner_closeout_ok /);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions, []);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "workflow-progress", `closeout-state-${taskId}.json`), "utf8"));
    assert.equal(state.optional_actions.session_cleanup, "complete");
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_mode, "soft-delete");
    assert.equal(archive.sessions[0].recoverable, true);
    assert.equal(fs.existsSync(path.join(artifactRoot, "planner-workspace.json")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
