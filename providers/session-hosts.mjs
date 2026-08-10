function fail(message) {
  throw new Error(message);
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
