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
const publicSession = session => {
  const { lookup_id, ...payload } = session;
  return payload;
};
const state = read();
if (args[0] === "session" && args[1] === "list") {
  if (process.env.ADWF_TEST_FAIL_LIST === "1") { process.stderr.write("database is locked\\n"); process.exit(9); }
  process.stdout.write(JSON.stringify(state.sessions.filter(session => session.active !== false).map(publicSession)));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "get") {
  if (args[2] !== "--json" || !args[3]) process.exit(2);
  const sessionId = args[3];
  if (process.env.ADWF_TEST_FAIL_GET === sessionId) { process.stderr.write("database is locked\\n"); process.exit(9); }
  const session = state.sessions.find(item => item.id === sessionId || item.lookup_id === sessionId);
  if (!session) { process.stderr.write("error: Session not found: " + sessionId + "\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(publicSession(session)));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  if (args.includes("--force")) process.exit(8);
  if (args[2] === failDelete) { process.stderr.write("thurbox delete failed for test\\n"); process.exit(7); }
  const index = state.sessions.findIndex(item => item.id === args[2]);
  if (index < 0) process.exit(1);
  state.sessions.splice(index, 1);
  write(state);
  process.stdout.write(JSON.stringify({ status: "deleted" }));
  process.exit(0);
}
process.exit(2);
`;

function writeNodeExecutable(directory, name, source) {
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`);
    fs.writeFileSync(path.join(directory, `${name}.cjs`), source);
    return;
  }
  const executable = path.join(directory, name);
  fs.writeFileSync(executable, source);
  fs.chmodSync(executable, 0o755);
}

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
  writeNodeExecutable(bin, "agent-deck", fakeAgentDeck);
  writeNodeExecutable(bin, "thurbox-cli", fakeThurbox);
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

function writeActiveTaskLock(artifactRoot, taskId) {
  const lockDir = path.join(artifactRoot, "active-task.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock.json"), `${JSON.stringify({
    task_id: taskId,
    integration_branch: "main",
    state: "sent"
  }, null, 2)}\n`);
  return lockDir;
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

integrationTest("task-session cleanup does not require provider resume metadata", () => {
  const taskId = "20260817-1200-optional-provider-id";
  const fixture = makeFixture([
    { id: "planner-1", title: "planner", tool: "shell", group: "", current: true },
    { id: "reviewer-1", title: `reviewer-${taskId}`, tool: "codex", group: "" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--planner-session-id", "planner-1",
      "--reviewer-session-id", "reviewer-1",
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["planner-1"]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.deepEqual(archive.sessions[0].provider_resume_ids, {});
    assert.equal(archive.sessions[0].has_provider_resume_id, false);
    assert.equal(archive.sessions[0].delete_status, "deleted");
    assert.equal("provider_guard_required" in archive.sessions[0], false);
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

integrationTest("task-session cleanup removes generic multi-role targets in one archive", () => {
  const taskId = "20260811-1200-design-targets";
  const fixture = makeFixture([
    { id: "requester-1", title: "requester", tool: "shell", group: "", current: true },
    { id: "author-1", title: `architect-author-${taskId}`, tool: "shell", group: "" },
    { id: "design-reviewer-1", title: `architect-reviewer-${taskId}`, tool: "shell", group: "" },
    { id: "shared-architect", title: "shared-architect", tool: "shell", group: "" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "design-closeout");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "requester-1",
      "--target", "architect-author=author-1",
      "--target", "architect-reviewer=design-reviewer-1",
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), ["requester-1", "shared-architect"]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.owner_session_id, "requester-1");
    assert.deepEqual(archive.sessions.map(session => session.role), ["architect-author", "architect-reviewer"]);
    assert.deepEqual(archive.sessions.map(session => session.delete_status), ["deleted", "deleted"]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup soft-deletes generic multi-role Thurbox targets", () => {
  const taskId = "20260811-1201-design-thurbox";
  const authorSessionId = "123e4567-e89b-42d3-a456-426614174010";
  const reviewerSessionId = "123e4567-e89b-42d3-a456-426614174011";
  const fixture = makeFixture([
    { id: authorSessionId, name: `architect-author-${taskId}`, cwd: "/tmp/work", parent_session_id: "requester-1" },
    { id: reviewerSessionId, name: `architect-reviewer-${taskId}`, cwd: "/tmp/work", parent_session_id: "requester-1" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "design-closeout");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "requester-1",
      "--session-host", "thurbox",
      "--target", `architect-author=${authorSessionId}`,
      "--target", `architect-reviewer=${reviewerSessionId}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions, []);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.deepEqual(archive.sessions.map(session => session.delete_mode), ["soft-delete", "soft-delete"]);
    assert.deepEqual(archive.sessions.map(session => session.recoverable), [true, true]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup does not resolve a Thurbox title as a target ID", () => {
  const taskId = "20260814-0749-thurbox-title-target";
  const alias = `coder-${taskId}`;
  const fixture = makeFixture([
    { id: alias, name: alias, cwd: "/tmp/work", parent_session_id: "planner-1" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--target", `coder=${alias}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_guard_blocked count=1 reason=invalid_session_id/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [alias]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].found, false);
    assert.equal(archive.sessions[0].delete_status, "blocked_invalid_session_id");
    assert.equal(archive.sessions[0].delete_block_reason, "invalid_session_id");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup rejects missing, invalid, or mismatched Thurbox response IDs", () => {
  const targetId = "123e4567-e89b-42d3-a456-426614174019";
  for (const testCase of [
    { name: "missing", responseId: undefined },
    { name: "invalid", responseId: "not-a-thurbox-uuid" },
    { name: "mismatched", responseId: "123e4567-e89b-42d3-a456-426614174022" }
  ]) {
    const taskId = `20260814-0749-thurbox-${testCase.name}-response-id`;
    const fixture = makeFixture([{
      lookup_id: targetId,
      ...(testCase.responseId === undefined ? {} : { id: testCase.responseId }),
      name: `coder-${taskId}`,
      cwd: "/tmp/work",
      parent_session_id: "planner-1"
    }]);
    try {
      const artifactRoot = path.join(fixture.temporary, "artifacts");
      const result = run(process.execPath, [
        archiveScript,
        "--task-id", taskId,
        "--owner-session-id", "planner-1",
        "--session-host", "thurbox",
        "--target", `coder=${targetId}`,
        "--artifact-root", artifactRoot,
        "--apply"
      ], { env: fixture.env });
      assert.equal(result.status, 3, result.stderr || result.stdout);
      assert.match(result.stdout, /delete_guard_blocked count=1 reason=session_id_mismatch/);
      assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.length, 1);
      const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
      assert.equal(archive.sessions[0].found, true);
      assert.equal(archive.sessions[0].session_id, testCase.responseId ?? null);
      assert.equal(archive.sessions[0].delete_status, "blocked_session_id_mismatch");
    } finally {
      fs.rmSync(fixture.temporary, { recursive: true, force: true });
    }
  }
});

integrationTest("task-session cleanup prefers an exact Thurbox ID over a title collision", () => {
  const taskId = "20260814-0749-thurbox-id-title-collision";
  const targetId = "123e4567-e89b-42d3-a456-426614174013";
  const collidingSessionId = "123e4567-e89b-42d3-a456-426614174014";
  const fixture = makeFixture([
    { id: collidingSessionId, name: targetId, cwd: "/tmp/work", parent_session_id: "planner-1" },
    { id: targetId, name: `coder-${taskId}`, cwd: "/tmp/work", parent_session_id: "planner-1" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--target", `coder=${targetId}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [collidingSessionId]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].session_id, targetId);
    assert.equal(archive.sessions[0].delete_status, "deleted");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup blocks a Thurbox target without parent ownership metadata", () => {
  const taskId = "20260814-0749-thurbox-missing-parent";
  const sessionId = "123e4567-e89b-42d3-a456-426614174015";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, cwd: "/tmp/work" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--target", `coder=${sessionId}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_guard_blocked count=1 reason=missing_parent_session_id/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [sessionId]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_status, "blocked_missing_parent_session_id");
    assert.equal(archive.sessions[0].delete_block_reason, "missing_parent_session_id");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup blocks a Thurbox target owned by another parent", () => {
  const taskId = "20260814-0749-thurbox-parent-mismatch";
  const sessionId = "123e4567-e89b-42d3-a456-426614174016";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, cwd: "/tmp/work", parent_session_id: "another-planner" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--target", `coder=${sessionId}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_guard_blocked count=1 reason=parent_session_id_mismatch/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [sessionId]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_status, "blocked_parent_session_id_mismatch");
    assert.equal(archive.sessions[0].delete_block_reason, "parent_session_id_mismatch");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup reports only blocked reasons in a mixed Thurbox batch", () => {
  const taskId = "20260814-0749-thurbox-mixed-status";
  const blockedSessionId = "123e4567-e89b-42d3-a456-426614174020";
  const preservedSessionId = "123e4567-e89b-42d3-a456-426614174021";
  const fixture = makeFixture([
    { id: blockedSessionId, name: `coder-${taskId}`, cwd: "/tmp/work" },
    { id: preservedSessionId, name: "shared-reviewer", cwd: "/tmp/work", parent_session_id: "planner-1" }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--owner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--target", `coder=${blockedSessionId}`,
      "--target", `reviewer=${preservedSessionId}`,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /delete_guard_blocked count=1 reason=missing_parent_session_id/);
    assert.doesNotMatch(result.stdout, /missing_parent_session_id,non_disposable_session/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [blockedSessionId, preservedSessionId]);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.deepEqual(archive.sessions.map(session => session.delete_status), ["blocked_missing_parent_session_id", "skipped_non_disposable_session"]);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup rejects duplicate generic and legacy roles", () => {
  const duplicate = run(process.execPath, [
    archiveScript,
    "--task-id", "20260811-1202-duplicate",
    "--target", "coder=coder-1",
    "--target", "coder=coder-1"
  ]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /duplicate cleanup target: coder=coder-1/);

  const mixed = run(process.execPath, [
    archiveScript,
    "--task-id", "20260811-1203-mixed",
    "--target", "coder=coder-1",
    "--coder-session-id", "coder-2"
  ]);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /supplied by both --target and a legacy option/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-target-repeat-test-"));
  try {
    const taskId = "20260811-1204-repeat-role";
    const artifactRoot = path.join(temporary, "artifacts");
    const repeatedRole = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--session-host", "unsupported-test-host",
      "--target", "participant=participant-1",
      "--target", "participant=participant-2",
      "--artifact-root", artifactRoot,
      "--apply"
    ]);
    assert.equal(repeatedRole.status, 0, repeatedRole.stderr || repeatedRole.stdout);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.deepEqual(archive.sessions.map(session => session.ref), ["participant-1", "participant-2"]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
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
  const sessionId = "123e4567-e89b-42d3-a456-426614174017";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, cwd: "/tmp/work", parent_session_id: "planner-1" }
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
      "--coder-session-id", sessionId
    ], { cwd: repository, env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /planner_closeout_ok /);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions, []);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "workflow-progress", `closeout-state-${taskId}.json`), "utf8"));
    assert.equal(state.optional_actions.session_cleanup, "complete");
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].delete_mode, "soft-delete");
    assert.equal(archive.sessions[0].recoverable, true);
    assert.equal(archive.sessions[0].path, "/tmp/work");
    assert.equal(archive.sessions[0].parent_session_id, "planner-1");
    assert.equal(fs.existsSync(path.join(artifactRoot, "planner-workspace.json")), false);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("planner closeout retains its task lock when a Thurbox ownership guard blocks cleanup", () => {
  const taskId = "20260814-0749-thurbox-closeout-ownership-guard";
  const sessionId = "123e4567-e89b-42d3-a456-426614174018";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, cwd: "/tmp/work" }
  ]);
  try {
    const { repository, artifactRoot } = initCloseoutRepository(fixture.temporary, taskId);
    const lockDir = writeActiveTaskLock(artifactRoot, taskId);
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
      "--coder-session-id", sessionId
    ], { cwd: repository, env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /planner_closeout_ok_with_optional_warn/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.map(session => session.id), [sessionId]);
    assert.equal(fs.existsSync(lockDir), true);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "workflow-progress", `closeout-state-${taskId}.json`), "utf8"));
    assert.equal(state.optional_actions.session_cleanup, "failed");
    assert.equal(state.optional_actions.workspace_lock, "retained_session_cleanup_failure");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup resolves an inactive Thurbox session by exact UUID", () => {
  const taskId = "20260809-1204-thurbox-inactive";
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, cwd: "/tmp/work", parent_session_id: "planner-1", active: false }
  ]);
  try {
    const artifactRoot = path.join(fixture.temporary, "artifacts");
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--planner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--coder-session-id", sessionId,
      "--artifact-root", artifactRoot,
      "--apply"
    ], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions, []);
    const archive = JSON.parse(fs.readFileSync(path.join(artifactRoot, taskId, `session-archive-${taskId}.json`), "utf8"));
    assert.equal(archive.sessions[0].found, true);
    assert.equal(archive.sessions[0].session_id, sessionId);
    assert.equal(archive.sessions[0].delete_status, "deleted");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("task-session cleanup fails closed when exact Thurbox UUID lookup fails", () => {
  const taskId = "20260809-1205-thurbox-get-failure";
  const sessionId = "123e4567-e89b-42d3-a456-426614174001";
  const fixture = makeFixture([
    { id: sessionId, name: `coder-${taskId}`, active: false }
  ]);
  try {
    const result = run(process.execPath, [
      archiveScript,
      "--task-id", taskId,
      "--planner-session-id", "planner-1",
      "--session-host", "thurbox",
      "--coder-session-id", sessionId,
      "--artifact-root", path.join(fixture.temporary, "artifacts"),
      "--apply"
    ], { env: { ...fixture.env, ADWF_TEST_FAIL_GET: sessionId } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed to query Thurbox session .*database is locked/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).sessions.length, 1);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

integrationTest("planner closeout retains its task lock when Thurbox inventory fails", () => {
  const taskId = "20260809-1204-thurbox-query-failure";
  const fixture = makeFixture([
    { id: "123e4567-e89b-42d3-a456-426614174023", name: `coder-${taskId}`, cwd: "/tmp/work", parent_session_id: "planner-1" }
  ]);
  try {
    const { repository, artifactRoot } = initCloseoutRepository(fixture.temporary, taskId);
    const lockDir = writeActiveTaskLock(artifactRoot, taskId);
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
      "--coder-session-id", "123e4567-e89b-42d3-a456-426614174023"
    ], { cwd: repository, env: { ...fixture.env, ADWF_TEST_FAIL_LIST: "1" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /planner_closeout_ok_with_optional_warn/);
    assert.equal(fs.existsSync(lockDir), true);
    assert.equal(fs.existsSync(path.join(artifactRoot, "planner-workspace.json")), true);
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "workflow-progress", `closeout-state-${taskId}.json`), "utf8"));
    assert.equal(state.optional_actions.session_cleanup, "failed");
    assert.equal(state.optional_actions.workspace_lock, "retained_session_cleanup_failure");
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
