import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateFramer,
  addContext,
  addFramer,
  addSynthesis,
  appendFramer,
  initFlow,
  setFlow,
  setRoundtable,
  showFlow
} from "../skills/intent-framing/scripts/flow.mjs";

function bodyFile(item, name, body) {
  const filePath = path.join(item.workdir, name);
  fs.writeFileSync(filePath, body);
  return filePath;
}

function fixture(mode = "sequence", input = "Find the user's real goal.\n") {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-intent-framing-"));
  const flowId = `${mode}-flow`;
  const inputFile = bodyFile({ workdir }, "request.md", input);
  const initialized = initFlow({ workdir, flowId, mode, inputFile });
  return { workdir, flowId, ...initialized };
}

function add(item, framerId, model = `model-${framerId}`) {
  return addFramer({ ...item, framerId, model, launcher: `launcher-${framerId}` });
}

function activate(item, framerId) {
  return activateFramer({
    ...item,
    framerId,
    sessionId: `session-${framerId}`,
    sessionHost: "test-host",
    sessionAddress: `personal/${framerId}`,
    returnAddress: "personal/requester"
  });
}

function cleanup(item) {
  fs.rmSync(item.workdir, { recursive: true, force: true });
}

test("sequence preserves its input and keeps framer records independent", () => {
  const original = "The visible request may not be the real goal.\n";
  const item = fixture("sequence", original);
  try {
    const first = add(item, "first", "model-a");
    const second = add(item, "second", "model-b");
    activate(item, "first");
    appendFramer({
      ...item,
      framerId: "first",
      kind: "question",
      bodyFile: bodyFile(item, "question.md", "What outcome matters most?")
    });
    appendFramer({
      ...item,
      framerId: "first",
      kind: "user",
      bodyFile: bodyFile(item, "answer.md", "Reduce the operator's cognitive load.")
    });

    assert.equal(fs.readFileSync(item.input, "utf8"), original);
    assert.match(fs.readFileSync(first.path, "utf8"), /What outcome matters most\?/);
    assert.match(fs.readFileSync(first.path, "utf8"), /Reduce the operator's cognitive load\./);
    assert.doesNotMatch(fs.readFileSync(second.path, "utf8"), /What outcome matters most\?/);
    assert.doesNotMatch(fs.readFileSync(first.path, "utf8"), /- Launcher:/);
    assert.equal(showFlow(item).current_framer.id, "first");
  } finally {
    cleanup(item);
  }
});

test("context and relayed text retain their original formatting", () => {
  const item = fixture();
  try {
    const contextBody = "  Retain leading space.\r\nAnd CRLF.\r\n";
    const context = addContext({ ...item, bodyFile: bodyFile(item, "context.md", contextBody) });
    assert.equal(fs.readFileSync(context.path, "utf8"), contextBody);

    const framer = add(item, "formatting");
    activate(item, "formatting");
    const response = "    indented code\r\n    stays indented\r\n";
    const manifestBefore = fs.readFileSync(item.manifest, "utf8");
    appendFramer({
      ...item,
      framerId: "formatting",
      kind: "complete",
      bodyFile: bodyFile(item, "response.md", response)
    });

    assert.equal(fs.readFileSync(framer.path, "utf8").endsWith(response), true);
    assert.equal(fs.readFileSync(item.manifest, "utf8"), manifestBefore);
  } finally {
    cleanup(item);
  }
});

test("stopped flows reject late changes and can resume explicitly", () => {
  const item = fixture();
  try {
    add(item, "only");
    activate(item, "only");
    setFlow({ ...item, status: "stopped" });

    assert.throws(() => appendFramer({
      ...item,
      framerId: "only",
      kind: "contribution",
      bodyFile: bodyFile(item, "late.md", "late update")
    }), /flow is not active: stopped/);
    assert.throws(
      () => addContext({ ...item, bodyFile: bodyFile(item, "late-context.md", "late context") }),
      /flow is not active: stopped/
    );

    setFlow({ ...item, status: "active" });
    appendFramer({
      ...item,
      framerId: "only",
      kind: "contribution",
      bodyFile: bodyFile(item, "resumed.md", "Resumed contribution.")
    });
    assert.equal(showFlow(item).status, "active");
  } finally {
    cleanup(item);
  }
});

test("the current session is the sole authenticated framer identity", () => {
  const item = fixture();
  try {
    add(item, "first");
    add(item, "second");
    assert.throws(() => activateFramer({
      ...item,
      framerId: "first",
      sessionId: "session-first",
      sessionHost: "test-host",
      sessionAddress: "personal/first"
    }), /--return-address must be non-empty/);
    activate(item, "first");
    assert.throws(() => appendFramer({
      ...item,
      framerId: "second",
      kind: "complete",
      bodyFile: bodyFile(item, "wrong.md", "wrong sender")
    }), /framer is not current/);

    activate(item, "second");
    const manifest = showFlow(item);
    assert.deepEqual(manifest.current_framer, {
      id: "second",
      path: "framers/002-second.md",
      session: {
        id: "session-second",
        host: "test-host",
        address: "personal/second"
      },
      return_address: "personal/requester"
    });
    assert.throws(() => appendFramer({
      ...item,
      framerId: "first",
      kind: "contribution",
      bodyFile: bodyFile(item, "stale.md", "stale sender")
    }), /framer is not current/);
  } finally {
    cleanup(item);
  }
});

test("roundtable keeps only its identity and local syntheses", () => {
  const item = fixture("roundtable", "Discuss the user's intent from several perspectives.\n");
  try {
    assert.equal(fs.existsSync(path.join(item.path, "framers")), false);
    setRoundtable({ ...item, roundtableId: "rt-1", groupAddress: "group/roundtable-rt-1" });
    const synthesis = addSynthesis({
      ...item,
      bodyFile: bodyFile(item, "synthesis.md", "One human-factor question remains.")
    });

    assert.equal(fs.readFileSync(synthesis.path, "utf8"), "One human-factor question remains.");
    assert.deepEqual(showFlow(item).roundtable, {
      id: "rt-1",
      group_address: "group/roundtable-rt-1"
    });
    const manifestBeforeRetry = fs.readFileSync(item.manifest, "utf8");
    setRoundtable({ ...item, roundtableId: "rt-1", groupAddress: "group/roundtable-rt-1" });
    assert.equal(fs.readFileSync(item.manifest, "utf8"), manifestBeforeRetry);
    assert.throws(
      () => setRoundtable({ ...item, roundtableId: "rt-2", groupAddress: "group/roundtable-rt-2" }),
      /roundtable identity is already bound/
    );
    assert.deepEqual(showFlow(item).roundtable, {
      id: "rt-1",
      group_address: "group/roundtable-rt-1"
    });
    assert.throws(
      () => addFramer({ ...item, framerId: "invalid", model: "model-a", launcher: "launcher-a" }),
      /framers are available only in sequence mode/
    );
  } finally {
    cleanup(item);
  }
});

test("artifact writers reject replaced symlink directories", t => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires elevated Windows privileges");
    return;
  }
  const sequence = fixture();
  const roundtable = fixture("roundtable");
  try {
    const outsideSequence = path.join(sequence.workdir, "outside-sequence");
    fs.mkdirSync(outsideSequence);
    fs.rmSync(path.join(sequence.path, "additions"), { recursive: true });
    fs.symlinkSync(outsideSequence, path.join(sequence.path, "additions"));
    assert.throws(() => addContext({
      ...sequence,
      bodyFile: bodyFile(sequence, "context.md", "must stay contained")
    }), /symlink|unsafe/);

    fs.rmSync(path.join(sequence.path, "framers"), { recursive: true });
    fs.symlinkSync(outsideSequence, path.join(sequence.path, "framers"));
    assert.throws(() => add(sequence, "escape"), /symlink|unsafe/);

    const outsideRoundtable = path.join(roundtable.workdir, "outside-roundtable");
    fs.mkdirSync(outsideRoundtable);
    fs.rmSync(path.join(roundtable.path, "roundtable"), { recursive: true });
    fs.symlinkSync(outsideRoundtable, path.join(roundtable.path, "roundtable"));
    assert.throws(() => addSynthesis({
      ...roundtable,
      bodyFile: bodyFile(roundtable, "synthesis.md", "must stay contained")
    }), /symlink|unsafe/);

    assert.deepEqual(fs.readdirSync(outsideSequence), []);
    assert.deepEqual(fs.readdirSync(outsideRoundtable), []);
  } finally {
    cleanup(sequence);
    cleanup(roundtable);
  }
});

test("required paths fail closed and invalid initialization leaves no flow", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-intent-framing-safe-"));
  try {
    assert.throws(
      () => initFlow({ flowId: "flow", mode: "sequence", inputFile: "missing.md" }),
      /--workdir is required/
    );
    assert.throws(
      () => initFlow({ workdir, flowId: "../escape", mode: "sequence", inputFile: "missing.md" }),
      /path-safe identifier/
    );
    assert.throws(
      () => initFlow({ workdir, flowId: "missing-input", mode: "sequence", inputFile: "missing.md" }),
      /--input-file is missing/
    );
    assert.equal(fs.existsSync(path.join(workdir, ".agent-artifacts", "intent-framing", "missing-input")), false);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
