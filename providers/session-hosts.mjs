function fail(message) {
  throw new Error(message);
}

export const AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS = 15000;
export const THURBOX_NUDGE_PROCESS_TIMEOUT_MS = 5000;

export function sessionNudgeSpec(options) {
  if (options.host === "agent-deck") {
    return {
      command: "agent-deck",
      timeoutMs: AGENT_DECK_NUDGE_PROCESS_TIMEOUT_MS,
      args: [
        "session", "send",
        "-defer-if-busy",
        "-defer-timeout", "5s",
        "-timeout", "5s",
        options.sessionId,
        options.message
      ]
    };
  }
  if (options.host === "thurbox") {
    return {
      command: "thurbox-cli",
      timeoutMs: THURBOX_NUDGE_PROCESS_TIMEOUT_MS,
      args: ["session", "send", options.sessionId, options.message]
    };
  }
  fail("Unsupported session host: " + options.host + ". Use agent-deck or thurbox.");
}

export function sessionDeletionSpec(options) {
  if (options.host === "agent-deck") {
    return {
      command: "agent-deck",
      args: [...(options.profile ? ["-p", options.profile] : []), "remove", options.sessionId],
      deleteMode: "remove",
      recoverable: false
    };
  }
  if (options.host === "thurbox") {
    if (options.profile) fail("--profile is only valid with --host agent-deck");
    return {
      command: "thurbox-cli",
      args: ["session", "delete", options.sessionId, "--json"],
      deleteMode: "soft-delete",
      recoverable: true
    };
  }
  fail("Unsupported session host: " + options.host + ". Use agent-deck or thurbox.");
}
