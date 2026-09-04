import fs from "node:fs";
import path from "node:path";
import {
  findMissingWorkflowLauncherApprovals,
  findMissingWaypostCliDeadLetterApprovals,
  findMissingWaypostCliFailApprovals,
  findRetiredPermissionApprovals
} from "../../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";
import {
  MAX_SKILL_NAME_LENGTH,
  resolveSelection,
  SKILL_PREFIX_PATTERN,
  upstreamSkillEntries
} from "./catalog.mjs";
import { decodeSimpleFrontmatterScalar } from "./skill-content.mjs";
import {
  provisionUpstreamSkill as defaultProvisionUpstreamSkill,
  selectedUpstreamSkillPlans
} from "./upstreams.mjs";
import {
  addReleaseToInventory,
  checkChannelGate,
  checkCommandCollisions,
  checkStateCoherence,
  chooseDeploymentMode,
  commandArtifactOwned,
  commandArtifactPaths,
  commandEntries,
  computePaths,
  copyOrLinkSkill,
  createInstallTransaction,
  destinationMatchesRecord,
  directoryFingerprint,
  discardRuntime,
  exists,
  expandHome,
  installRuntimeCommand,
  installedSkillDestination,
  installedSkillName,
  installedSkillRuntimeRelativePath,
  publishRuntime,
  readInstallState,
  retiredCommandEntries,
  resolvedLinkTarget,
  rollbackRuntimePublication,
  saveInstallState,
  SOURCE_CHANNEL,
  SOURCE_CHANNEL_STATE_TOKEN,
  stageRuntime,
  targetState,
  updateTargetState,
  validateSharedRuntimeConsumers,
  validateStateGrammar,
  writeInstalledSkillMarker
} from "./runtime.mjs";
import { retireLegacyAgyDiscovery } from "../../providers/legacy-agy-skill-discovery.mjs";

export const DEFAULT_TARGETS = ["general", "gemini", "agy", "claude"];

const PERMISSION_MIGRATION_COMMANDS = new Set(["adwf-send-and-wake"]);

function fail(message) {
  throw new Error(message);
}

function validateInstalledSkillName(skill, prefix) {
  const installedAs = installedSkillName(skill, prefix);
  if (installedAs.length > MAX_SKILL_NAME_LENGTH) {
    fail(
      `Installed skill name ${JSON.stringify(installedAs)} exceeds `
      + `${MAX_SKILL_NAME_LENGTH} characters`
    );
  }
  return installedAs;
}

function validateSkillPrefix(catalog, prefix) {
  if (!SKILL_PREFIX_PATTERN.test(prefix)) {
    fail(`Invalid skill prefix ${JSON.stringify(prefix)}; use lowercase kebab-case`);
  }
  const knownSkills = [
    ...Object.keys(catalog.skills.skills ?? {}),
    ...upstreamSkillEntries(catalog).map(entry => entry.name),
    ...(catalog.skills.retiredSkills ?? [])
  ];
  const conflict = knownSkills
    .sort()
    .find(skill => skill === prefix || skill.startsWith(`${prefix}-`));
  if (conflict) {
    fail(`Skill prefix ${JSON.stringify(prefix)} conflicts with known skill ${JSON.stringify(conflict)}`);
  }
  return prefix;
}

function validateRecordedSkillPrefix(catalog, state) {
  if (state?.skillPrefix === null || state === null) return;
  try {
    validateSkillPrefix(catalog, state.skillPrefix);
    const installedSkills = new Set(Object.values(state.targets)
      .flatMap(record => Object.keys(record.skills)));
    for (const skill of installedSkills) validateInstalledSkillName(skill, state.skillPrefix);
  } catch (error) {
    fail(`Invalid recorded skill prefix: ${error.message}`);
  }
}

function installationSkillPrefix(catalog, state, options) {
  const recorded = state?.skillPrefix ?? null;
  const prefix = options.prefix === undefined ? recorded : options.prefix;
  if (prefix !== null) validateSkillPrefix(catalog, prefix);
  const hasInstalledSkills = Object.values(state?.targets ?? {})
    .some(record => Object.keys(record.skills).length > 0);
  if (hasInstalledSkills && prefix !== recorded) {
    fail(
      `Cannot change recorded skill prefix from ${JSON.stringify(recorded)} to ${JSON.stringify(prefix)}; `
      + "uninstall all managed skills before reinstalling with a different prefix"
    );
  }
  return prefix;
}

export function retiredPermissionMigrationScopes(options, env = process.env) {
  const candidates = [{ scope: "user", project: options.project }];
  if (options.scope === "project") {
    candidates.push({ scope: "project", project: options.project });
  }
  return candidates
    .map(candidate => findRetiredPermissionApprovals({ ...candidate, env }))
    .filter(result => result.required);
}

export function permissionMigrationScopes(options, env = process.env) {
  const candidates = [
    { scope: "user", project: options.project },
    { scope: "project", project: options.project }
  ];
  return candidates
    .map(candidate => {
      const retired = findRetiredPermissionApprovals({ ...candidate, env });
      const launcher = findMissingWorkflowLauncherApprovals({ ...candidate, env });
      const waypostFail = findMissingWaypostCliFailApprovals({ ...candidate, env });
      const waypostDeadLetter = findMissingWaypostCliDeadLetterApprovals({ ...candidate, env });
      return {
        ...candidate,
        required: retired.required || launcher.required || waypostFail.required || waypostDeadLetter.required,
        reasons: [
          ...(retired.required ? ["retired-approval"] : []),
          ...(launcher.required ? ["missing-workflow-launcher"] : []),
          ...(waypostFail.required ? ["missing-waypost-cli-fail"] : []),
          ...(waypostDeadLetter.required ? ["missing-waypost-cli-dead-letter"] : [])
        ],
        issues: [...retired.issues, ...launcher.issues, ...waypostFail.issues, ...waypostDeadLetter.issues]
      };
    })
    .filter(result => result.required);
}

export function printPermissionMigrationRequirement({
  print,
  commandRetired = false,
  detectedScopes = []
}) {
  const isRetiredResult = result => result.reasons?.includes("retired-approval")
    || (!Array.isArray(result.reasons) && result.required);
  const retiredDetected = detectedScopes.some(isRetiredResult);
  const retiredSessionResolve = detectedScopes.some(result =>
    result.issues?.some(issue => issue.includes("session_resolve")));
  const retiredCommandApproval = commandRetired || detectedScopes.some(result =>
    result.issues?.some(issue => /adwf-send-and-wake|review-tech-design/.test(issue)));
  const launcherMissing = detectedScopes.some(result => result.reasons?.includes("missing-workflow-launcher"));
  const waypostFailMissing = detectedScopes.some(result => result.reasons?.includes("missing-waypost-cli-fail"));
  const waypostDeadLetterMissing = detectedScopes.some(result => result.reasons?.includes("missing-waypost-cli-dead-letter"));
  if (!commandRetired && !retiredDetected && !launcherMissing && !waypostFailMissing && !waypostDeadLetterMissing) return;
  const retiredScopes = [...new Set(detectedScopes
    .filter(isRetiredResult)
    .map(result => result.scope))];
  const launcherScopes = [...new Set(detectedScopes
    .filter(result => result.reasons?.includes("missing-workflow-launcher"))
    .map(result => result.scope))];
  const waypostFailScopes = [...new Set(detectedScopes
    .filter(result => result.reasons?.includes("missing-waypost-cli-fail"))
    .map(result => result.scope))];
  const waypostDeadLetterScopes = [...new Set(detectedScopes
    .filter(result => result.reasons?.includes("missing-waypost-cli-dead-letter"))
    .map(result => result.scope))];
  if (retiredCommandApproval) {
    print("SECURITY ACTION REQUIRED: permission_migration_required command=adwf-send-and-wake");
  }
  if (retiredSessionResolve) {
    print("SECURITY ACTION REQUIRED: permission_migration_required tool=session_resolve");
  }
  if (launcherMissing) {
    print("SECURITY ACTION REQUIRED: permission_migration_required missing=workflow-launcher");
  }
  if (waypostFailMissing) {
    print("SECURITY ACTION REQUIRED: permission_migration_required missing=waypost-cli-fail");
  }
  if (waypostDeadLetterMissing) {
    print("SECURITY ACTION REQUIRED: permission_migration_required missing=waypost-cli-dead-letter");
  }
  if (retiredScopes.length > 0) {
    print(`Detected retired permission approvals in scope(s): ${retiredScopes.join(",")}`);
  }
  if (launcherScopes.length > 0) {
    print(`Detected outdated workflow launcher approvals in scope(s): ${launcherScopes.join(",")}`);
  }
  if (waypostFailScopes.length > 0) {
    print(`Detected outdated Waypost CLI approvals in scope(s): ${waypostFailScopes.join(",")}`);
  }
  if (waypostDeadLetterScopes.length > 0) {
    print(`Detected outdated Waypost CLI approvals in scope(s): ${waypostDeadLetterScopes.join(",")}`);
  }
  print("Run: agentgear permissions init");
  print("For every project where workflow permissions were initialized, run: agentgear permissions init --scope project --project <path>");
  print("Restart existing agent sessions after updating permissions.");
}

export function selected(catalog, options) {
  return resolveSelection(catalog, {
    packs: options.packs,
    skills: options.skills
  });
}

export function selectedInstallableSkills(catalog, selection) {
  return [...selection.exposedSkills];
}

export function resolveTargetRoots(catalog, options, env = process.env) {
  const names = options.targets.length === 0
    ? (options.destination ? ["general"] : DEFAULT_TARGETS)
    : options.targets;
  if (options.destination && names.length !== 1) {
    fail("--dest requires exactly one target");
  }
  const roots = names.map(name => {
    const target = catalog.targets.targets[name];
    if (!target) fail("Unknown target: " + name);
    const configuredPath = options.destination || target[options.scope];
    const root = options.scope === "global"
      ? path.resolve(expandHome(configuredPath, env))
      : path.resolve(options.project, configuredPath);
    return { name, root };
  });
  const seen = new Set();
  return roots.filter(target => {
    if (seen.has(target.root)) return false;
    seen.add(target.root);
    return true;
  });
}

function ensureSourceSkills(sourceRoot, selection) {
  for (const skill of selection.capabilitySkills) {
    const skillFile = path.join(sourceRoot, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillFile)) fail("Missing canonical skill: " + skillFile);
  }
}

function targetInstallPlan(state, targets, skillsByTarget, options, skillPrefix) {
  const errors = [];
  const plan = [];
  for (const target of targets) {
    const recorded = state === null ? { skills: {} } : targetState(state, target.root);
    for (const skill of skillsByTarget.get(target.root)) {
      const installedAs = validateInstalledSkillName(skill, skillPrefix);
      const destination = path.join(target.root, installedAs);
      const record = recorded.skills[skill];
      const destinationExists = exists(destination);
      if (destinationExists && !record && !options.force) {
        errors.push("Unmanaged skill already exists: " + destination);
      } else if (destinationExists && record && !destinationMatchesRecord(destination, record, skill, installedAs) && !options.force) {
        errors.push("Installer-managed skill changed locally: " + destination + " (use --force to replace it)");
      }
      plan.push({ target, skill, installedAs, destination, record, destinationExists });
    }
  }
  if (errors.length > 0) fail(errors.join("\n"));
  return plan;
}

function retiredSkillPlan(catalog, state, targetRoots = null) {
  const retired = new Set(catalog.skills.retiredSkills ?? []);
  const plan = [];
  for (const [targetRoot, targetRecord] of Object.entries(state?.targets ?? {})) {
    if (targetRoots && !targetRoots.has(targetRoot)) continue;
    for (const [skill, record] of Object.entries(targetRecord.skills ?? {})) {
      if (!retired.has(skill)) continue;
      const installedAs = installedSkillName(skill, state.skillPrefix);
      const destination = path.join(targetRoot, installedAs);
      const destinationExists = exists(destination);
      plan.push({
        targetRoot,
        skill,
        record,
        destination,
        destinationExists,
        owned: destinationExists && destinationMatchesRecord(destination, record, skill, installedAs)
      });
    }
  }
  return plan;
}

function withdrawnSkillPlan(state, targets, skillsByTarget, authoritative) {
  if (!authoritative || state === null) return [];
  const plan = [];
  for (const target of targets) {
    const desired = new Set(skillsByTarget.get(target.root));
    const record = targetState(state, target.root);
    for (const [skill, item] of Object.entries(record.skills)) {
      if (desired.has(skill)) continue;
      const installedAs = installedSkillName(skill, state.skillPrefix);
      const destination = path.join(target.root, installedAs);
      const destinationExists = exists(destination);
      if (destinationExists && !destinationMatchesRecord(destination, item, skill, installedAs)) {
        fail(`Refusing to withdraw locally changed skill: ${destination}`);
      }
      plan.push({ targetRoot: target.root, skill, destination, destinationExists });
    }
  }
  return plan;
}

function rewriteInstalledSkillFrontmatter(skillFile, canonicalSkill, installedAs) {
  const source = fs.readFileSync(skillFile, "utf8");
  const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/.exec(source);
  if (!frontmatter) fail(`Invalid canonical skill frontmatter: ${skillFile}`);
  const lines = frontmatter[2].split(/\r?\n/);
  const nameIndex = lines.findIndex(line => line.startsWith("name:"));
  const declaredName = nameIndex === -1
    ? null
    : decodeSimpleFrontmatterScalar(lines[nameIndex].slice("name:".length));
  if (declaredName !== canonicalSkill) {
    fail(`Canonical skill name does not match its directory: ${skillFile}`);
  }
  lines[nameIndex] = `name: ${installedAs}`;
  const newline = frontmatter[1].endsWith("\r\n") ? "\r\n" : "\n";
  const replacement = `${frontmatter[1]}${lines.join(newline)}${frontmatter[3]}`;
  fs.writeFileSync(skillFile, replacement + source.slice(frontmatter[0].length));
}

function assertRealPathUnderRoot(root, candidate, leafType) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Unsafe projected skill path: ${candidate}`);
  }
  let current = resolvedRoot;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink()) fail(`Projected skill path is missing or unsafe: ${candidate}`);
    const leaf = index === parts.length - 1;
    if (leaf) {
      if (leafType === "file" ? !info.isFile() : !info.isDirectory()) {
        fail(`Projected skill path has the wrong type: ${candidate}`);
      }
    } else if (!info.isDirectory()) {
      fail(`Projected skill path has an unsafe ancestor: ${candidate}`);
    }
  }
}

function rewriteInstalledSkillPrompt(promptFile, canonicalSkill, installedAs) {
  const source = fs.readFileSync(promptFile, "utf8");
  const escaped = canonicalSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selfInvocation = new RegExp(`\\$${escaped}(?![A-Za-z0-9_-])`, "g");
  const rewritten = source.replace(selfInvocation, () => `$${installedAs}`);
  if (rewritten !== source) fs.writeFileSync(promptFile, rewritten);
}

function skillProjectionPlans(state, plan, removedSkills, plannedLinks) {
  const projections = new Map();
  const add = (skill, needsLinkMarker) => {
    const projection = projections.get(skill) ?? { skill, needsLinkMarker: false };
    projection.needsLinkMarker ||= needsLinkMarker;
    projections.set(skill, projection);
  };
  for (const item of plan) add(item.skill, plannedLinks);

  const removed = new Set(removedSkills.map(item => item.destination));
  for (const [targetRoot, targetRecord] of Object.entries(state?.targets ?? {})) {
    for (const [skill, record] of Object.entries(targetRecord.skills ?? {})) {
      if (record.mode !== "link") continue;
      if (removed.has(installedSkillDestination(targetRoot, skill, state.skillPrefix))) continue;
      add(skill, true);
    }
  }
  return [...projections.values()];
}

function materializeSkillProjections({ runtime, projections, skillPrefix, env }) {
  const paths = computePaths(env);
  fs.rmSync(path.join(runtime.root, "discovery-skills"), { recursive: true, force: true });
  for (const { skill, needsLinkMarker } of projections) {
    const canonicalSource = path.join(runtime.root, "skills", skill);
    const canonicalInfo = fs.lstatSync(canonicalSource, { throwIfNoEntry: false });
    if (!canonicalInfo) continue;
    assertRealPathUnderRoot(runtime.root, canonicalSource, "directory");
    assertRealPathUnderRoot(runtime.root, path.join(canonicalSource, "SKILL.md"), "file");

    const runtimeRelative = installedSkillRuntimeRelativePath(skill, skillPrefix);
    const stagedSource = path.join(runtime.root, runtimeRelative);
    const installedAs = installedSkillName(skill, skillPrefix);
    if (skillPrefix) {
      const promptDirectory = path.join(canonicalSource, "agents");
      const promptDirectoryInfo = fs.lstatSync(promptDirectory, { throwIfNoEntry: false });
      const promptFile = path.join(promptDirectory, "openai.yaml");
      const hasPrompt = Boolean(promptDirectoryInfo)
        && Boolean(fs.lstatSync(promptFile, { throwIfNoEntry: false }));
      if (promptDirectoryInfo) assertRealPathUnderRoot(runtime.root, promptDirectory, "directory");
      if (hasPrompt) assertRealPathUnderRoot(runtime.root, promptFile, "file");

      fs.mkdirSync(path.dirname(stagedSource), { recursive: true });
      fs.cpSync(canonicalSource, stagedSource, { recursive: true, preserveTimestamps: true });
      assertRealPathUnderRoot(runtime.root, stagedSource, "directory");
      assertRealPathUnderRoot(runtime.root, path.join(stagedSource, "SKILL.md"), "file");
      rewriteInstalledSkillFrontmatter(path.join(stagedSource, "SKILL.md"), skill, installedAs);
      if (hasPrompt) {
        const stagedPrompt = path.join(stagedSource, "agents", "openai.yaml");
        assertRealPathUnderRoot(runtime.root, stagedPrompt, "file");
        rewriteInstalledSkillPrompt(stagedPrompt, skill, installedAs);
      }
    }
    if (needsLinkMarker) {
      writeInstalledSkillMarker(stagedSource, skill, {
        installedAs,
        mode: "link",
        source: path.join(paths.currentPath, runtimeRelative)
      });
    }
  }
}

export function installSelection({
  catalog,
  options,
  sourceRoot,
  sourceInstall = false,
  env = process.env,
  print = () => {},
  provisionUpstreamSkill = defaultProvisionUpstreamSkill
}) {
  const selection = selected(catalog, options);
  const resolvedTargets = resolveTargetRoots(catalog, options, env);
  print("Checking installation state...");
  ensureSourceSkills(sourceRoot, selection);
  const state = readInstallState(env);
  const grammar = validateStateGrammar(state, env);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths(env).stateFile}: ${grammar.reason}`);
  }
  validateRecordedSkillPrefix(catalog, state);
  const skillPrefix = installationSkillPrefix(catalog, state, options);
  const targets = resolvedTargets;
  const requestedChannel = sourceInstall ? SOURCE_CHANNEL : "release";
  const persistedChannel = sourceInstall ? SOURCE_CHANNEL_STATE_TOKEN : requestedChannel;
  checkChannelGate(state, requestedChannel);
  checkStateCoherence(state, env);
  const upstreamPlans = selectedUpstreamSkillPlans(catalog, selection, state, env);
  const skillsByTarget = new Map(targets.map(target => [
    target.root,
    selectedInstallableSkills(catalog, selection)
  ]));
  const installedSkills = [...new Set([...skillsByTarget.values()].flat())];
  const installLauncher = !options.noLauncher;
  const retirementRoots = options.scope === "global" && !options.destination
    ? null
    : new Set(targets.map(target => target.root));
  const retiredSkills = retiredSkillPlan(catalog, state, retirementRoots);
  const withdrawnSkills = withdrawnSkillPlan(
    state,
    targets,
    skillsByTarget,
    selection.packs.length > 0
  );
  const removedSkills = [...retiredSkills, ...withdrawnSkills];
  const retiredCommands = retiredCommandEntries(env)
    .filter(entry => state?.commands?.[entry.destination]);
  const detectedPermissionScopes = permissionMigrationScopes(options, env);
  for (const entry of retiredCommands) {
    const record = state.commands[entry.destination];
    const artifactExists = commandArtifactPaths(entry.destination).some(candidate => exists(candidate));
    if (artifactExists && !commandArtifactOwned(entry.destination, record)) {
      fail(`Refusing to retire locally changed command: ${entry.destination}`);
    }
  }
  const plan = targetInstallPlan(state, targets, skillsByTarget, options, skillPrefix);
  checkCommandCollisions(state, env, installLauncher, options.force);

  let currentState = state;
  let runtime;
  let publication;
  let transaction;
  let committed = false;

  try {
    print("Staging runtime snapshot...");
    runtime = stageRuntime({ sourceRoot, env });
    const paths = computePaths(env);
    const previousRuntimeRoots = [
      paths.currentPath,
      ...(state?.releases ?? []).map(releaseId => path.join(paths.releasesRoot, releaseId))
    ];
    for (const upstreamPlan of upstreamPlans) {
      provisionUpstreamSkill({
        plan: upstreamPlan,
        runtime,
        previousRuntimeRoots,
        env,
        print
      });
    }
    print("Checking deployment mode...");
    const mode = chooseDeploymentMode({ runtime, targets, sourceInstall, state, env, print });
    const shared = sourceInstall && mode === "shared";
    // Discovery projections keep canonical runtime content and script
    // addresses unchanged while exposing a distinct harness-facing name.
    // Runtime markers describe only link consumers; copy provenance is local
    // to each final destination and is written after deployment below.
    const projections = skillProjectionPlans(
      state,
      plan,
      removedSkills,
      shared
    );
    materializeSkillProjections({ runtime, projections, skillPrefix, env });
    print("Validating staged runtime...");
    const consumerErrors = validateSharedRuntimeConsumers({
      runtime,
      state,
      env,
      mode,
      sourceInstall,
      installLauncher,
      retireCommandDestinations: retiredCommands.map(entry => entry.destination),
      removedSkillDestinations: removedSkills.map(entry => entry.destination),
      plannedSkills: plan.map(item => item.skill),
      skillPrefix
    });
    if (consumerErrors.length > 0) fail(consumerErrors.join("\n"));

    if (currentState === null) {
      currentState = {
        schemaVersion: 3,
        skillPrefix,
        channel: persistedChannel,
        releases: [],
        targets: {},
        commands: {}
      };
    }
    currentState.skillPrefix = skillPrefix;
    transaction = createInstallTransaction();
    let copiedSkillTargets = 0;
    print(
      `Installing ${installedSkills.length} skill(s) to `
      + `${targets.map(target => target.name).join(", ")}...`
    );

    for (const item of retiredSkills) {
      if (item.owned) {
        transaction.remove([item.destination]);
        print(`removed retired skill: ${item.destination}`);
      } else if (item.destinationExists) {
        print(`preserved locally changed retired skill: ${item.destination}`);
      }
      const record = targetState(currentState, item.targetRoot);
      delete record.skills[item.skill];
      updateTargetState(currentState, item.targetRoot, record);
    }

    for (const item of withdrawnSkills) {
      if (item.destinationExists) {
        transaction.remove([item.destination]);
        print(`withdrawn skill: ${item.skill}`);
      } else {
        print(`removed stale skill record: ${item.skill}`);
      }
      const record = targetState(currentState, item.targetRoot);
      delete record.skills[item.skill];
      updateTargetState(currentState, item.targetRoot, record);
    }

    for (const target of targets) {
      const record = targetState(currentState, target.root);
      for (const item of plan.filter(candidate => candidate.target.name === target.name)) {
        const runtimeRelative = installedSkillRuntimeRelativePath(item.skill, skillPrefix);
        const source = path.join(shared ? computePaths(env).currentPath : runtime.root, runtimeRelative);
        const keepsLink = shared
          && item.record?.mode === "link"
          && item.destinationExists
          && resolvedLinkTarget(item.destination) === source;
        if (!keepsLink) {
          const deployment = transaction.replace([item.destination], () => copyOrLinkSkill({
            source,
            copySource: path.join(runtime.root, runtimeRelative),
            destination: item.destination,
            link: shared ? "strict" : false,
            print
          }));
          if (deployment.mode === "link") {
            record.skills[item.skill] = { mode: "link", source };
          } else {
            const fingerprint = directoryFingerprint(item.destination);
            record.skills[item.skill] = { mode: "copy", fingerprint };
            writeInstalledSkillMarker(item.destination, item.skill, {
              installedAs: item.installedAs,
              mode: "copy",
              source: fingerprint
            });
            if (shared) copiedSkillTargets += 1;
          }
        } else {
          record.skills[item.skill] = { mode: "link", source };
        }
      }
      updateTargetState(currentState, target.root, record);
    }

    for (const entry of retiredCommands) {
      const record = currentState.commands[entry.destination];
      if (!record) continue;
      transaction.remove(commandArtifactPaths(entry.destination));
      print(`removed retired command: ${entry.destination}`);
      delete currentState.commands[entry.destination];
    }

    if (installLauncher) {
      for (const entry of commandEntries(env)) {
        currentState.commands[entry.destination] = installRuntimeCommand({
          command: entry.command,
          kind: entry.kind,
          destination: entry.destination,
          runtime,
          mode,
          relativeModule: entry.relativeModule,
          print,
          transaction,
          env
        });
      }
    }

    retireLegacyAgyDiscovery({ state: currentState, transaction, env, print });
    addReleaseToInventory(currentState, runtime.id);
    if (currentState.channel === null || currentState.channel === SOURCE_CHANNEL) {
      currentState.channel = persistedChannel;
    }
    if (mode === "shared") {
      print("Publishing shared runtime...");
      publication = publishRuntime(runtime, currentState, env);
    }
    print("Saving installation state...");
    saveInstallState(currentState, env);
    transaction.commit();
    committed = true;

    const channel = sourceInstall
      ? (shared ? "shared source install" : "source-install copy fallback")
      : "release snapshot";
    print("Installed " + installedSkills.length + " skill(s) to " + targets.map(target => target.name).join(", ") + " (" + channel + ").");
    if (selection.packs.length > 0) {
      print("Pack selection reconciled managed discovery entries; restart existing agent sessions to reload skill discovery.");
    }
    if (options.noLauncher && installedSkills.length > 0) {
      print("Warning: exposed skill bootstraps require a compatible agentgear skill get launcher.");
    }
    if (copiedSkillTargets > 0) {
      print("Copied " + copiedSkillTargets + " skill(s) because links are unavailable at their destination.");
    }
    if (selection.requirements.commands.length > 0) {
      print("Run: agentgear doctor --pack " + selection.packs.at(-1));
    }
    printPermissionMigrationRequirement({
      print,
      commandRetired: retiredCommands.some(entry => PERMISSION_MIGRATION_COMMANDS.has(entry.command)),
      detectedScopes: detectedPermissionScopes
    });
  } catch (error) {
    let rollbackSucceeded = true;
    if (!committed && publication?.published) {
      try {
        rollbackRuntimePublication(publication);
      } catch (rollbackError) {
        rollbackSucceeded = false;
        error.message += `; additionally failed to restore the previous shared runtime: ${rollbackError.message}`;
      }
    }
    if (!committed && transaction) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        rollbackSucceeded = false;
        error.message += `; additionally failed to restore installation paths: ${rollbackError.message}`;
      }
    }
    if (!committed && runtime) {
      if (rollbackSucceeded) {
        discardRuntime(runtime);
      } else {
        error.message += `; partial rollback: retained staged release ${runtime.root} without recording it (manual recovery required)`;
      }
    }
    throw error;
  }
}
