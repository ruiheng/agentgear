import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionProbeOutcome,
  sessionProbeSpec
} from "../providers/session-hosts.mjs";

const ok = stdout => ({ status: 0, stdout, stderr: "", error: null, signal: null, timedOut: false });
const exited = (status, stderr = "") => ({ status, stdout: "", stderr, error: null, signal: null, timedOut: false });

test("sessionProbeSpec maps hosted schemes to read-only probe commands", () => {
  assert.deepEqual(sessionProbeSpec({ host: "agent-deck", sessionId: "abc" }), {
    command: "agent-deck",
    timeoutMs: 10000,
    args: ["session", "show", "abc", "--json"]
  });
  assert.deepEqual(sessionProbeSpec({ host: "thurbox", sessionId: "abc" }), {
    command: "thurbox-cli",
    timeoutMs: 5000,
    args: ["session", "get", "--json", "abc"]
  });
  for (const host of ["codex", "waypost", "claude", "devin", "gemini"]) {
    assert.equal(sessionProbeSpec({ host, sessionId: "abc" }), null, host);
  }
});

test("agent-deck probe classifies exists, not_found, and unknown", () => {
  assert.equal(sessionProbeOutcome("agent-deck", ok("{\"success\":true}")).status, "exists");
  assert.equal(sessionProbeOutcome("agent-deck", exited(2, "session not found")).status, "not_found");
  assert.equal(sessionProbeOutcome("agent-deck", exited(1, "boom")).status, "unknown");
  assert.equal(sessionProbeOutcome("agent-deck", ok("not json")).status, "unknown");
  assert.equal(sessionProbeOutcome("agent-deck", ok("{\"success\":false,\"error\":\"denied\"}")).status, "unknown");
});

test("thurbox probe classifies exists, not_found, and unknown", () => {
  assert.equal(sessionProbeOutcome("thurbox", ok("{}")).status, "exists");
  assert.equal(sessionProbeOutcome("thurbox", exited(1, "session not found")).status, "not_found");
  assert.equal(sessionProbeOutcome("thurbox", exited(1, "permission denied")).status, "unknown");
  assert.equal(sessionProbeOutcome("thurbox", exited(2, "bad usage")).status, "unknown");
});

test("probe interruption and spawn errors stay inconclusive", () => {
  for (const host of ["agent-deck", "thurbox"]) {
    assert.equal(sessionProbeOutcome(host, { status: null, stdout: "", stderr: "", error: null, signal: "SIGTERM", timedOut: false }).status, "unknown");
    assert.equal(sessionProbeOutcome(host, { status: null, stdout: "", stderr: "", error: null, signal: null, timedOut: true }).status, "unknown");
    assert.equal(sessionProbeOutcome(host, { status: null, stdout: "", stderr: "", error: new Error("spawn failed"), signal: null, timedOut: false }).status, "unknown");
  }
});
