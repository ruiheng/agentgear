import fs from "node:fs";
import path from "node:path";
import { computePaths, readInstallState, validateStateGrammar } from "./runtime.mjs";

export const LEGACY_SKILL_NAMES = Object.freeze([
  "agent-deck",
  "agent-deck-workflow",
  "assess-design-spec",
  "assess-tech-design",
  "browser-test",
  "browser-test-request",
  "check-waypost-messages",
  "code-health-review",
  "commit-staged",
  "coordinate-design-spec",
  "delegate-code-task",
  "delegate-task",
  "dispatch-plan",
  "execute-plan",
  "explain-for-me",
  "explore-defects",
  "fix-strategy",
  "handoff",
  "multi-agent-protocol",
  "plan-report",
  "planner-closeout",
  "refactor-review",
  "refactor-review-request",
  "review-closeout",
  "review-code",
  "review-design-spec",
  "review-request",
  "review-tech-design",
  "roundtable",
  "roundtable-participant",
  "simplify-review",
  "tech-design-assessment",
  "tech-design-review",
  "tech-design-review-request",
  "tech-design-review-workflow",
  "tech-design-workflow"
]);

const LEGACY_SET = new Set(LEGACY_SKILL_NAMES);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function fail(message) {
  throw new Error(message);
}

function absentStateOnly(env) {
  const stateFile = computePaths(env).stateFile;
  const stateInfo = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (stateInfo && (!stateInfo.isFile() || stateInfo.isSymbolicLink())) {
    fail(`Legacy skill migration refused: invalid installation state ${stateFile}: state path is not a safe regular file`);
  }
  let state;
  try {
    state = readInstallState(env);
  } catch (error) {
    fail(`Legacy skill migration refused: could not read installation state ${stateFile}: ${error.message}`);
  }
  const grammar = validateStateGrammar(state, env);
  if (!grammar.valid) {
    fail(`Legacy skill migration refused: invalid installation state ${stateFile}: ${grammar.reason}`);
  }
  if (state !== null) {
    fail("Legacy skill migration refused: recorded Agentgear installation exists; use install/update/uninstall ownership reconciliation.");
  }
}

function realRoot(root) {
  const info = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Unsafe legacy migration root: ${root}`);
  return path.resolve(root);
}

function candidatesForRoot(root) {
  const resolved = realRoot(root);
  if (!resolved) return [];
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    fail(`Could not inspect legacy migration root ${resolved}: ${error.message}`);
  }
  const candidates = [];
  for (const entry of entries) {
    if (!LEGACY_SET.has(entry.name)) continue;
    const candidate = path.resolve(resolved, entry.name);
    if (path.dirname(candidate) !== resolved) fail(`Unsafe legacy migration candidate: ${candidate}`);
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function backupPath(candidate, sequence) {
  return path.join(path.dirname(candidate), `.${path.basename(candidate)}.agentgear-legacy-${process.pid}-${Date.now()}-${sequence}`);
}

export function validateLegacySkillNames() {
  const sorted = [...LEGACY_SKILL_NAMES].sort(compareUtf8);
  if (sorted.join("\0") !== LEGACY_SKILL_NAMES.join("\0")) throw new Error("Legacy skill whitelist must be bytewise sorted");
  if (new Set(LEGACY_SKILL_NAMES).size !== LEGACY_SKILL_NAMES.length) throw new Error("Legacy skill whitelist contains duplicates");
  if (!LEGACY_SKILL_NAMES.every(name => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) {
    throw new Error("Legacy skill whitelist contains an unsafe skill name");
  }
}

export function migrateLegacySkills({ roots, apply = false, env = process.env, print = () => {} }) {
  validateLegacySkillNames();
  absentStateOnly(env);
  const uniqueRoots = [...new Set(roots.map(root => path.resolve(root)))].sort(compareUtf8);
  const candidates = uniqueRoots.flatMap(candidatesForRoot).sort(compareUtf8);
  print("EXCEPTIONAL ONE-TIME MIGRATION: name whitelist is deletion authority");
  if (!apply) {
    for (const candidate of candidates) print(`would remove legacy skill: ${candidate}`);
    print(`Legacy skill migration dry run: ${candidates.length} candidate(s); rerun with --apply.`);
    return { candidates, removed: [] };
  }

  // Recheck all authority before changing anything.
  absentStateOnly(env);
  const rechecked = uniqueRoots.flatMap(candidatesForRoot).sort(compareUtf8);
  if (rechecked.join("\0") !== candidates.join("\0")) {
    fail("Legacy skill migration refused: candidate set changed during preflight; rerun the command.");
  }
  const moved = [];
  try {
    for (const [index, candidate] of candidates.entries()) {
      const backup = backupPath(candidate, index);
      fs.renameSync(candidate, backup);
      moved.push({ candidate, backup });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of moved.reverse()) {
      try {
        fs.renameSync(item.backup, item.candidate);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.candidate}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) error.message += `; additionally failed to restore legacy candidates: ${rollbackErrors.join("; ")}`;
    throw error;
  }
  const residual = [];
  for (const item of moved) {
    try {
      fs.rmSync(item.backup, { recursive: true, force: true });
      print(`removed legacy skill: ${item.candidate}`);
    } catch (error) {
      residual.push(`${item.backup}: ${error.message}`);
    }
  }
  if (residual.length > 0) fail(`Legacy skill migration incomplete: ${residual.join("; ")}`);
  print(`Legacy skill migration complete: ${moved.length} removed.`);
  return { candidates, removed: moved.map(item => item.candidate) };
}
