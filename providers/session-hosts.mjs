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
        "session", "send", "--json",
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

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function commandError(result) {
  return optionalText(result.stderr)
    || optionalText(result.stdout)
    || result.error?.message
    || `exit code ${result.status}`;
}

export function sessionNudgeOutcome(host, result) {
  if (result.timedOut || result.signal) {
    return {
      status: "unconfirmed",
      scheme: host,
      detail: result.timedOut
        ? "nudge command timed out after delivery may already have been attempted"
        : `nudge command terminated by ${result.signal} after delivery may already have been attempted`,
      error: null
    };
  }
  if (result.error) {
    return { status: "failed", scheme: host, detail: null, error: result.error.message };
  }
  if (host !== "agent-deck") {
    return result.status === 0
      ? { status: "sent", scheme: host, detail: null, error: null }
      : { status: "failed", scheme: host, detail: null, error: commandError(result) };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return result.status === 0
      ? { status: "sent", scheme: host, detail: null, error: null }
      : { status: "failed", scheme: host, detail: null, error: commandError(result) };
  }

  const delivery = optionalText(payload.delivery)?.toLowerCase() || "";
  if (payload.submitted === true || delivery === "submitted") {
    return { status: "sent", scheme: host, detail: null, error: null };
  }
  const unconfirmedDetails = {
    typed: "nudge reached the target pane but turn submission was not confirmed",
    unverified: "nudge was sent but agent-deck could not verify whether the target accepted it",
    no_evidence: "nudge was attempted but no delivery evidence was observed"
  };
  if (unconfirmedDetails[delivery]) {
    return { status: "unconfirmed", scheme: host, detail: unconfirmedDetails[delivery], error: null };
  }
  if (["typed_not_submitted", "line_too_long", "send_failed"].includes(delivery)) {
    return {
      status: "failed",
      scheme: host,
      detail: null,
      error: optionalText(payload.error) || commandError(result)
    };
  }
  if (delivery) {
    return {
      status: "unconfirmed",
      scheme: host,
      detail: `agent-deck returned an unknown delivery verdict ${JSON.stringify(delivery)}`,
      error: null
    };
  }
  if (payload.success === true && result.status === 0) {
    return { status: "sent", scheme: host, detail: null, error: null };
  }
  if (payload.success === false || result.status !== 0) {
    return {
      status: "failed",
      scheme: host,
      detail: null,
      error: optionalText(payload.error) || commandError(result)
    };
  }
  return {
    status: "unconfirmed",
    scheme: host,
    detail: "agent-deck returned structured output without a delivery verdict",
    error: null
  };
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
