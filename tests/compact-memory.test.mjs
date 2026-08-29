import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  agentgearSkillGetArgv,
  compactAdditionalContext,
  handleHook,
  sessionMemoryDirectory,
  STICKY_MESSAGE_LIMIT
} from "../skills/multi-agent-protocol/scripts/compact-memory-hook.mjs";
import {
  appendStickyTaskContextMarker,
  hasStickyTaskContextMarker,
  STICKY_TASK_CONTEXT_MARKER
} from "../skills/multi-agent-protocol/scripts/compact-memory-shared.mjs";
import {
  codexCompactMemoryLauncherUsable,
  doctorCodexCompactMemory,
  installCodexCompactMemory,
  uninstallCodexCompactMemory
} from "../providers/codex-compact-memory.mjs";
import { loadActionProducerManifest } from "../skills/multi-agent-protocol/scripts/action-producer.mjs";

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-compact-memory-"));
  const home = path.join(temporary, "home");
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(temporary, "state"),
    XDG_DATA_HOME: path.join(temporary, "data"),
    CODEX_HOME: path.join(temporary, "codex")
  };
  return { temporary, env };
}

function recvEvent(sessionId, deliveryId, body, subject = "task") {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__waypost__waypost_recv",
    tool_input: {},
    tool_response: {
      structuredContent: {
        status: "received",
        delivery: {
          delivery_id: deliveryId,
          sender_address: "workflow/planner",
          recipient_address: "workflow/coder",
          subject,
          body,
          lease_token: "must-not-be-persisted"
        }
      }
    }
  };
}

test("sticky task marker is one idempotent final non-empty line", () => {
  const source = "Task body\n";
  const marked = appendStickyTaskContextMarker(source);
  assert.equal(marked, `Task body\n\n${STICKY_TASK_CONTEXT_MARKER}\n`);
  assert.equal(appendStickyTaskContextMarker(marked), marked);
  for (const trailing of [
    "Markdown hard break  ",
    "Trailing tab\t",
    "Several blank lines\n\n\n",
    "CRLF blank line\r\n\r\n",
    "Whitespace-only final line\n  "
  ]) {
    const preserved = appendStickyTaskContextMarker(trailing);
    assert.equal(preserved.startsWith(trailing), true, JSON.stringify(trailing));
    assert.equal(hasStickyTaskContextMarker(preserved), true, JSON.stringify(trailing));
    assert.equal(appendStickyTaskContextMarker(preserved), preserved, JSON.stringify(trailing));
  }
  assert.equal(hasStickyTaskContextMarker(`${marked}\n  \n`), true);
  assert.equal(hasStickyTaskContextMarker(`${STICKY_TASK_CONTEXT_MARKER}\nmore`), false);
  assert.equal(hasStickyTaskContextMarker(` ${STICKY_TASK_CONTEXT_MARKER}`), false);
  assert.equal(hasStickyTaskContextMarker(`${STICKY_TASK_CONTEXT_MARKER} `), false);
});

test("declared task-context actions are sticky while later review notifications are not", () => {
  const multi = loadActionProducerManifest(pathToFileURL(
    path.resolve("skills/multi-agent-protocol/scripts/action-producers.mjs")
  ).href);
  const task = multi.factories.EXECUTE_DELEGATE_TASK({ before: [], after: [], body: "coder task" });
  let taskBody;
  multi.senders.EXECUTE_DELEGATE_TASK(task, {
    toAddress: "coder", fromAddress: "planner", subject: "task", contentType: "text/markdown", schemaVersion: "1",
    runCommand(_command, _args, options) { taskBody = options.input; return { status: 0 }; }
  });
  assert.equal(hasStickyTaskContextMarker(taskBody), true);

  const reviewerContext = multi.factories.REVIEW_TASK_CONTEXT({ before: [], after: [], body: "review task" });
  let reviewerBody;
  multi.senders.REVIEW_TASK_CONTEXT(reviewerContext, {
    toAddress: "reviewer", fromAddress: "planner", subject: "task", contentType: "text/markdown", schemaVersion: "1",
    runCommand(_command, _args, options) { reviewerBody = options.input; return { status: 0 }; }
  });
  assert.equal(hasStickyTaskContextMarker(reviewerBody), true);

  const design = loadActionProducerManifest(pathToFileURL(
    path.resolve("skills/tech-design-workflow/scripts/action-producers.mjs")
  ).href);
  for (const name of ["DESIGN_SPEC_REVIEW_CONTEXT", "DESIGN_SPEC_DRAFT_REQUESTED", "DESIGN_PRUNE_CONTEXT"]) {
    const context = design.factories[name]({ before: [], after: [], body: "design task" });
    let contextBody;
    design.senders[name](context, {
      toAddress: "worker", fromAddress: "requester", subject: "task", contentType: "text/markdown", schemaVersion: "1",
      runCommand(_command, _args, options) { contextBody = options.input; return { status: 0 }; }
    });
    assert.equal(hasStickyTaskContextMarker(contextBody), true, name);
  }
  const notification = design.factories.DESIGN_SPEC_REVIEW_REQUESTED({ before: [], after: [], body: "" });
  let notificationBody;
  design.senders.DESIGN_SPEC_REVIEW_REQUESTED(notification, {
    toAddress: "reviewer", fromAddress: "author", subject: "review", contentType: "text/markdown", schemaVersion: "1",
    runCommand(_command, _args, options) { notificationBody = options.input; return { status: 0 }; }
  });
  assert.equal(hasStickyTaskContextMarker(notificationBody), false);
  const pruneNotification = design.factories.DESIGN_PRUNE_REQUESTED({ before: [], after: [], body: "" });
  let pruneNotificationBody;
  design.senders.DESIGN_PRUNE_REQUESTED(pruneNotification, {
    toAddress: "pruner", fromAddress: "author", subject: "prune", contentType: "text/markdown", schemaVersion: "1",
    runCommand(_command, _args, options) { pruneNotificationBody = options.input; return { status: 0 }; }
  });
  assert.equal(hasStickyTaskContextMarker(pruneNotificationBody), false);
});

test("PostToolUse keeps only sticky Waypost identifiers and subjects in one session index", () => {
  const item = fixture();
  try {
    const sessionId = "thread-sticky";
    const sticky = appendStickyTaskContextMarker("Implement the parser.");
    handleHook(recvEvent(sessionId, "dlv_sticky", sticky), { env: item.env });
    handleHook(recvEvent(sessionId, "dlv_plain", "ordinary notification"), { env: item.env });
    handleHook(recvEvent(sessionId, "dlv_sticky", sticky), { env: item.env });

    const root = sessionMemoryDirectory(sessionId, item.env);
    assert.deepEqual(fs.readdirSync(root), ["memory.json"]);
    const memory = JSON.parse(fs.readFileSync(path.join(root, "memory.json"), "utf8"));
    assert.deepEqual(
      memory.sticky_messages.map(({ delivery_id, subject }) => ({ delivery_id, subject })),
      [{ delivery_id: "dlv_sticky", subject: "task" }]
    );
    assert.equal(JSON.stringify(memory).includes("Implement the parser."), false);
    assert.equal(JSON.stringify(memory).includes("lease_token"), false);

    const context = compactAdditionalContext(sessionId, { env: item.env });
    assert.match(context, /delivery="dlv_sticky" subject="task"/);
    assert.match(context, /Sticky Waypost tasks already received/);
    assert.match(context, /read these deliveries by ID; do not use recv/);
    assert.doesNotMatch(context, /file=/);
    assert.doesNotMatch(context, /Implement the parser/);
    assert.doesNotMatch(context, /dlv_plain/);
    assert.doesNotMatch(context, /agentgear skill get/i);
    assert.equal(compactAdditionalContext("another-thread", { env: item.env }), null);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("invalid session memory is reported and never overwritten", () => {
  const item = fixture();
  try {
    const sessionId = "thread-invalid-memory";
    const root = sessionMemoryDirectory(sessionId, item.env);
    const file = path.join(root, "memory.json");
    const original = "{not-json\n";
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, original);

    const restored = handleHook({
      session_id: sessionId, hook_event_name: "SessionStart", source: "compact"
    }, { env: item.env });
    assert.match(restored.systemMessage, /compact memory was not restored: Cannot read compact memory/);
    assert.equal(Object.hasOwn(restored, "hookSpecificOutput"), false);

    const updated = handleHook({
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "agentgear skill get handoff" },
      tool_response: { exit_code: 0, output: "skill text" }
    }, { env: item.env });
    assert.match(updated.systemMessage, /compact memory was not updated: Cannot read compact memory/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Waypost message bodies are terminal data rather than nested response envelopes", () => {
  const item = fixture();
  try {
    const nested = JSON.stringify({
      delivery_id: "dlv_synthetic",
      subject: "not a real envelope",
      body: appendStickyTaskContextMarker("Nested text")
    });
    handleHook(recvEvent("thread-nested-body", "dlv_outer", nested), { env: item.env });
    assert.equal(compactAdditionalContext("thread-nested-body", { env: item.env }), null);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("sticky Waypost memory keeps the most recent bounded set", () => {
  const item = fixture();
  try {
    const sessionId = "thread-ring";
    for (let index = 0; index < STICKY_MESSAGE_LIMIT + 2; index += 1) {
      handleHook(recvEvent(
        sessionId,
        `dlv_${String(index).padStart(2, "0")}`,
        appendStickyTaskContextMarker(`Task ${index}`),
        `task ${index}`
      ), { env: item.env, now: () => new Date(1_000 + index) });
    }
    const context = compactAdditionalContext(sessionId, { env: item.env });
    assert.doesNotMatch(context, /dlv_00|dlv_01/);
    assert.match(context, /dlv_02/);
    assert.match(context, new RegExp(`dlv_${String(STICKY_MESSAGE_LIMIT + 1).padStart(2, "0")}`));
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("PostToolUse remembers successful direct Agentgear skill gets only", () => {
  const item = fixture();
  try {
    const base = {
      session_id: "thread-skills",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { exit_code: 0, output: "skill text" }
    };
    handleHook({ ...base, tool_input: { command: "agentgear skill get delegate-code-task multi-agent-protocol/shared-protocol" } }, { env: item.env });
    handleHook({ ...base, tool_input: { command: "agentgear skill get delegate-code-task multi-agent-protocol/shared-protocol" } }, { env: item.env });
    handleHook({ ...base, tool_input: { command: "agentgear skill get delegate-code-task && echo unsafe" } }, { env: item.env });
    handleHook({ ...base, tool_input: { command: "agentgear skill get search-files" }, tool_response: { exit_code: 1 } }, { env: item.env });
    const output = handleHook({
      session_id: "thread-skills", hook_event_name: "SessionStart", source: "compact"
    }, { env: item.env });
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /Earlier `agentgear skill get` calls \(rerun if needed\):/);
    assert.match(context, /^- delegate-code-task multi-agent-protocol\/shared-protocol$/m);
    assert.equal(context.match(/agentgear skill get/g)?.length, 1);
    assert.doesNotMatch(context, /echo unsafe|search-files/);
    assert.doesNotMatch(context, /Sticky Waypost/);
    const root = sessionMemoryDirectory("thread-skills", item.env);
    assert.deepEqual(fs.readdirSync(root), ["memory.json"]);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("direct command recognition accepts only a leading PowerShell call operator", () => {
  const windows = { platform: "win32" };
  assert.deepEqual(
    agentgearSkillGetArgv("& agentgear skill get handoff", windows),
    ["agentgear", "skill", "get", "handoff"]
  );
  assert.deepEqual(
    agentgearSkillGetArgv('& "C:\\Users\\Example User\\.local\\bin\\agentgear.cmd" skill get handoff', windows),
    ["agentgear", "skill", "get", "handoff"]
  );
  assert.equal(agentgearSkillGetArgv("& agentgear skill get handoff", { platform: "linux" }), null);
  assert.equal(agentgearSkillGetArgv("&agentgear skill get handoff", windows), null);
  assert.equal(agentgearSkillGetArgv("& agentgear skill get handoff & echo unsafe", windows), null);
});

test("PowerShell direct Waypost reads can preserve sticky messages", () => {
  const item = fixture();
  try {
    const sticky = appendStickyTaskContextMarker("Windows task");
    handleHook({
      session_id: "thread-powershell",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: '& "C:\\Program Files\\Waypost\\waypost.exe" read --delivery dlv_windows --json' },
      tool_response: {
        exit_code: 0,
        output: JSON.stringify({ delivery_id: "dlv_windows", subject: "task", body: sticky })
      }
    }, { env: item.env, platform: "win32" });
    assert.match(compactAdditionalContext("thread-powershell", { env: item.env }), /dlv_windows/);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("direct Waypost capture requires JSON output", () => {
  const item = fixture();
  try {
    const sticky = appendStickyTaskContextMarker("CLI task");
    const base = {
      session_id: "thread-cli-formats",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { exit_code: 0 }
    };
    handleHook({
      ...base,
      tool_input: { command: "waypost recv --for workflow/coder --full" },
      tool_response: { ...base.tool_response, output: `delivery_id=dlv_text subject="task"\n${sticky}` }
    }, { env: item.env });
    handleHook({
      ...base,
      tool_input: { command: "waypost read --delivery dlv_yaml --yaml" },
      tool_response: { ...base.tool_response, output: `delivery_id: dlv_yaml\nsubject: task\nbody: |\n  ${sticky}` }
    }, { env: item.env });
    assert.equal(compactAdditionalContext("thread-cli-formats", { env: item.env }), null);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory installer is idempotent and preserves unrelated hooks", () => {
  const item = fixture();
  try {
    fs.mkdirSync(path.dirname(item.env.CODEX_HOME), { recursive: true });
    fs.mkdirSync(item.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(item.env.CODEX_HOME, "hooks.json"), `${JSON.stringify({
      custom: "keep",
      hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "keep" }] }] }
    }, null, 2)}\n`);
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);

    const first = installCodexCompactMemory({ env: item.env, launcher });
    const second = installCodexCompactMemory({ env: item.env, launcher });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    const document = JSON.parse(fs.readFileSync(first.path, "utf8"));
    assert.equal(document.custom, "keep");
    assert.equal(document.hooks.PreToolUse[0].hooks[0].command, "keep");
    assert.equal(document.hooks.PostToolUse.length, 1);
    assert.equal(document.hooks.SessionStart.length, 1);
    assert.equal(document.hooks.SessionStart[0].hooks[0].async, false);
    assert.equal(
      document.hooks.PostToolUse[0].hooks[0].commandWindows,
      `node '${launcher}' compact-memory-hook`
    );
    const doctor = doctorCodexCompactMemory({ env: item.env, launcher });
    assert.deepEqual(doctor.missing, []);
    assert.equal(doctor.launcherUsable, true);

    document.hooks.SessionStart[0].hooks[0].additionalContextLimit = 1;
    fs.writeFileSync(first.path, `${JSON.stringify(document, null, 2)}\n`);
    assert.deepEqual(doctorCodexCompactMemory({ env: item.env, launcher }).missing, ["SessionStart"]);

    document.hooks.SessionStart[0].hooks[0].additionalContextLimit = 8000;
    document.hooks.SessionStart[0].hooks[0].async = true;
    fs.writeFileSync(first.path, `${JSON.stringify(document, null, 2)}\n`);
    assert.deepEqual(doctorCodexCompactMemory({ env: item.env, launcher }).missing, ["SessionStart"]);

    document.hooks.SessionStart[0].hooks[0].async = false;
    document.hooks.SessionStart.push({
      description: document.hooks.SessionStart[0].description,
      matcher: "^compact$",
      hooks: [{ type: "command", command: "stale" }]
    });
    fs.writeFileSync(first.path, `${JSON.stringify(document, null, 2)}\n`);
    assert.deepEqual(doctorCodexCompactMemory({ env: item.env, launcher }).missing, ["SessionStart"]);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory ownership is exact and uninstall preserves similar user hooks", () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);
    fs.mkdirSync(item.env.CODEX_HOME, { recursive: true });
    const similar = {
      description: "Agentgear Codex compact memory user extension",
      matcher: "^Bash$",
      hooks: [{ type: "command", command: "keep" }]
    };
    const hooksPath = path.join(item.env.CODEX_HOME, "hooks.json");
    fs.writeFileSync(hooksPath, `${JSON.stringify({ hooks: { PostToolUse: [similar] } }, null, 2)}\n`);

    installCodexCompactMemory({ env: item.env, launcher });
    let document = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    assert.equal(document.hooks.PostToolUse.length, 2);
    assert.deepEqual(document.hooks.PostToolUse[0], similar);

    const removed = uninstallCodexCompactMemory({ env: item.env });
    assert.equal(removed.changed, true);
    document = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    assert.deepEqual(document.hooks, { PostToolUse: [similar] });
    assert.equal(uninstallCodexCompactMemory({ env: item.env }).changed, false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory refuses malformed hook groups without changing the file", () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);
    fs.mkdirSync(item.env.CODEX_HOME, { recursive: true });
    const hooksPath = path.join(item.env.CODEX_HOME, "hooks.json");
    const original = '{"hooks":{"SessionStart":["malformed"]}}\n';
    fs.writeFileSync(hooksPath, original);

    assert.throws(
      () => installCodexCompactMemory({ env: item.env, launcher }),
      /hooks\.SessionStart\[0\] must be an object/
    );
    assert.equal(fs.readFileSync(hooksPath, "utf8"), original);
    assert.throws(
      () => doctorCodexCompactMemory({ env: item.env, launcher }),
      /hooks\.SessionStart\[0\] must be an object/
    );
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory preserves a hooks symlink and target mode", {
  skip: process.platform === "win32"
}, () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);

    const managed = path.join(item.temporary, "managed");
    const target = path.join(managed, "hooks.json");
    const hooksPath = path.join(item.env.CODEX_HOME, "hooks.json");
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(item.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(target, "{}\n", { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(path.relative(item.env.CODEX_HOME, target), hooksPath);

    installCodexCompactMemory({ env: item.env, launcher });
    assert.equal(fs.lstatSync(hooksPath).isSymbolicLink(), true);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.match(fs.readFileSync(target, "utf8"), /Agentgear Codex compact memory/);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory refuses to rewrite unsafe JSON numbers", () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);
    fs.mkdirSync(item.env.CODEX_HOME, { recursive: true });
    const hooksPath = path.join(item.env.CODEX_HOME, "hooks.json");
    for (const literal of ["9007199254740993", "0.12345678901234567890"]) {
      const original = `{"external":{"value":${literal}}}\n`;
      fs.writeFileSync(hooksPath, original);
      assert.throws(
        () => installCodexCompactMemory({ env: item.env, launcher }),
        /cannot round-trip safely/
      );
      assert.equal(fs.readFileSync(hooksPath, "utf8"), original);
    }
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Windows hook command uses one literal launcher argument without a cmd shim", () => {
  const item = fixture();
  try {
    const launcher = path.join(
      item.env.HOME,
      "cash$() `tick %PATH% O'Brien",
      "agentgear"
    );
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    const result = installCodexCompactMemory({ env: item.env, launcher, platform: "win32" });
    const document = JSON.parse(fs.readFileSync(result.path, "utf8"));
    const command = document.hooks.PostToolUse[0].hooks[0].commandWindows;
    assert.equal(
      command,
      `node '${launcher.replaceAll("'", "''")}' compact-memory-hook`
    );
    assert.doesNotMatch(command, /\.cmd/u);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory install refuses a missing stable launcher before writing hooks", () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    assert.throws(
      () => installCodexCompactMemory({ env: item.env, launcher }),
      /Agentgear launcher is not usable/
    );
    assert.equal(fs.existsSync(path.join(item.env.CODEX_HOME, "hooks.json")), false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("compact-memory CLI installs, diagnoses, and uninstalls the Codex hooks", () => {
  const item = fixture();
  try {
    const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
    fs.chmodSync(launcher, 0o755);
    const executable = path.resolve("bin/agentgear.mjs");
    const invoke = argumentsList => childProcess.spawnSync(process.execPath, [executable, ...argumentsList], {
      cwd: path.resolve("."),
      env: item.env,
      encoding: "utf8"
    });

    const installed = invoke(["compact-memory", "install"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /compact-memory hooks installed/);
    const doctor = invoke(["compact-memory", "doctor"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /capture hook: configured/);
    assert.match(doctor.stdout, /recovery hook: configured/);
    const uninstalled = invoke(["compact-memory", "uninstall"]);
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.match(uninstalled.stdout, /compact-memory hooks uninstalled/);
    const after = invoke(["compact-memory", "doctor"]);
    assert.equal(after.status, 1, after.stderr);
    assert.match(after.stdout, /capture hook: missing/);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("full Agentgear purge unregisters compact-memory hooks before removing the launcher", () => {
  const item = fixture();
  try {
    const executable = path.resolve("bin/agentgear.mjs");
    const invoke = argumentsList => childProcess.spawnSync(process.execPath, [executable, ...argumentsList], {
      cwd: path.resolve("."),
      env: item.env,
      encoding: "utf8"
    });
    const installed = invoke(["install", "--skill", "handoff", "--target", "general"]);
    assert.equal(installed.status, 0, installed.stderr);
    const hooked = invoke(["compact-memory", "install"]);
    assert.equal(hooked.status, 0, hooked.stderr);

    const purged = invoke(["uninstall", "--purge"]);
    assert.equal(purged.status, 0, purged.stderr);
    assert.match(purged.stdout, /unregistered Codex compact-memory hooks/);
    assert.equal(fs.existsSync(path.join(item.env.HOME, ".local", "bin", "agentgear")), false);
    const document = JSON.parse(fs.readFileSync(path.join(item.env.CODEX_HOME, "hooks.json"), "utf8"));
    assert.equal(Object.hasOwn(document, "hooks"), false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("Codex compact-memory launcher checks reject unusable platform artifacts", () => {
  const item = fixture();
  const launcher = path.join(item.env.HOME, ".local", "bin", "agentgear");
  try {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.mkdirSync(launcher);
    assert.equal(codexCompactMemoryLauncherUsable(launcher, { platform: "linux" }), false);
    fs.rmdirSync(launcher);

    fs.writeFileSync(launcher, "launcher");
    if (process.platform !== "win32") {
      fs.chmodSync(launcher, 0o600);
      assert.equal(codexCompactMemoryLauncherUsable(launcher, { platform: "linux" }), false);
      fs.chmodSync(launcher, 0o755);
      assert.equal(codexCompactMemoryLauncherUsable(launcher, { platform: "linux" }), true);
    }
    assert.equal(codexCompactMemoryLauncherUsable(launcher, { platform: "win32" }), true);

    if (process.platform !== "win32") {
      const target = path.join(item.temporary, "missing-target");
      fs.rmSync(launcher, { force: true });
      fs.symlinkSync(target, launcher);
      assert.equal(codexCompactMemoryLauncherUsable(launcher, { platform: "linux" }), false);
    }
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("compact-memory hook module imports when argv entry is not a file", () => {
  const moduleUrl = pathToFileURL(path.resolve(
    "skills/multi-agent-protocol/scripts/compact-memory-hook.mjs"
  )).href;
  const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: path.resolve("."),
    input: `import ${JSON.stringify(moduleUrl)};\n`,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});
