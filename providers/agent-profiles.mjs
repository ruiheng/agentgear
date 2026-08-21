const AGENT_PROFILE = /^[a-z0-9][a-z0-9-]*$/;

export const agentProfiles = Object.freeze({
  codex: Object.freeze({
    heading: "## For Codex only",
    detect(env) {
      return Boolean(
        env.CODEX_THREAD_ID
        && (env.CODEX_SANDBOX || Object.hasOwn(env, "CODEX_CI") || env.CODEX_MANAGED_PACKAGE_ROOT)
      );
    }
  })
});

export function detectAgentProfiles(env = process.env) {
  return Object.entries(agentProfiles).flatMap(([profile, definition]) => {
    try {
      return definition.detect(env) ? [profile] : [];
    } catch {
      return [];
    }
  });
}

export function resolveAgentProfiles({ env = process.env, override } = {}) {
  if (override === undefined) return detectAgentProfiles(env);
  if (override === "generic") return [];
  if (!AGENT_PROFILE.test(override) || !Object.hasOwn(agentProfiles, override)) {
    throw new Error(`Unknown agent profile: ${override}`);
  }
  return [override];
}
