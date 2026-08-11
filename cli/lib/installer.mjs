import fs from "node:fs";
import path from "node:path";
import {
  findMissingWorkflowLauncherApprovals,
  findRetiredPermissionApprovals
} from "../../skills/multi-agent-protocol/scripts/workflow-permissions.mjs";
import { resolveSelection } from "./catalog.mjs";
import {
  provisionUpstreamSkill as defaultProvisionUpstreamSkill,
  selectedUpstreamSkillNames,
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
  publishRuntime,
  readInstallState,
  retiredCommandEntries,
  resolvedLinkTarget,
  rollbackRuntimePublication,
  saveInstallState,
  stageRuntime,
  targetState,
  updateTargetState,
  validateSharedRuntimeConsumers,
  validateStateGrammar
} from "./runtime.mjs";

export const DEFAULT_TARGETS = ["general", "claude"];

const PERMISSION_MIGRATION_COMMANDS = new Set(["adwf-send-and-wake"]);

function fail(message) {
  throw new Error(message);
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
      return {
        ...candidate,
        required: retired.required || launcher.required,
        reasons: [
          ...(retired.required ? ["retired-command"] : []),
          ...(launcher.required ? ["missing-workflow-launcher"] : [])
        ],
        issues: [...retired.issues, ...launcher.issues]
      };
    })
    .filter(result => result.required);
}

export function printPermissionMigrationRequirement({
  print,
  commandRetired = false,
  detectedScopes = []
}) {
  const isRetiredResult = result => result.reasons?.includes("retired-command")
    || (!Array.isArray(result.reasons) && result.required);
  const retiredDetected = detectedScopes.some(isRetiredResult);
  const launcherMissing = detectedScopes.some(result => result.reasons?.includes("missing-workflow-launcher"));
  if (!commandRetired && !retiredDetected && !launcherMissing) return;
  const retiredScopes = [...new Set(detectedScopes
    .filter(isRetiredResult)
    .map(result => result.scope))];
  const launcherScopes = [...new Set(detectedScopes
    .filter(result => result.reasons?.includes("missing-workflow-launcher"))
    .map(result => result.scope))];
  if (commandRetired || retiredDetected) {
    print("SECURITY ACTION REQUIRED: permission_migration_required command=adwf-send-and-wake");
  }
  if (launcherMissing) {
    print("SECURITY ACTION REQUIRED: permission_migration_required missing=tech-design-workflow-launcher");
  }
  if (retiredScopes.length > 0) {
    print(`Detected retired permission approvals in scope(s): ${retiredScopes.join(",")}`);
  }
  if (launcherScopes.length > 0) {
    print(`Detected outdated workflow launcher approvals in scope(s): ${launcherScopes.join(",")}`);
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
  return [...new Set([
    ...selection.skills,
    ...selectedUpstreamSkillNames(catalog, selection)
  ])];
}

export function resolveTargetRoots(catalog, options, env = process.env) {
  const names = options.targets.length === 0
    ? (options.destination ? ["general"] : DEFAULT_TARGETS)
    : options.targets;
  if (options.destination && names.length !== 1) {
    fail("--dest requires exactly one target");
  }
  return names.map(name => {
    const target = catalog.targets.targets[name];
    if (!target) fail("Unknown target: " + name);
    const configuredPath = options.destination || target[options.scope];
    const root = options.scope === "global"
      ? path.resolve(expandHome(configuredPath, env))
      : path.resolve(options.project, configuredPath);
    return { name, root };
  });
}

function ensureSourceSkills(sourceRoot, selection) {
  for (const skill of selection.skills) {
    const skillFile = path.join(sourceRoot, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillFile)) fail("Missing canonical skill: " + skillFile);
  }
}

function targetInstallPlan(state, targets, skills, options) {
  const errors = [];
  const plan = [];
  for (const target of targets) {
    const recorded = state === null ? { skills: {} } : targetState(state, target.root);
    for (const skill of skills) {
      const destination = path.join(target.root, skill);
      const record = recorded.skills[skill];
      const destinationExists = exists(destination);
      if (destinationExists && !record && !options.force) {
        errors.push("Unmanaged skill already exists: " + destination);
      } else if (destinationExists && record && !destinationMatchesRecord(destination, record) && !options.force) {
        errors.push("Installer-managed skill changed locally: " + destination + " (use --force to replace it)");
      }
      plan.push({ target, skill, destination, record, destinationExists });
    }
  }
  if (errors.length > 0) fail(errors.join("\n"));
  return plan;
}

function retiredSkillPlan(catalog, state) {
  const retired = new Set(catalog.skills.retiredSkills ?? []);
  const plan = [];
  for (const [targetRoot, targetRecord] of Object.entries(state?.targets ?? {})) {
    for (const [skill, record] of Object.entries(targetRecord.skills ?? {})) {
      if (!retired.has(skill)) continue;
      const destination = path.join(targetRoot, skill);
      const destinationExists = exists(destination);
      plan.push({
        targetRoot,
        skill,
        record,
        destination,
        destinationExists,
        owned: destinationExists && destinationMatchesRecord(destination, record)
      });
    }
  }
  return plan;
}

export function installSelection({
  catalog,
  options,
  sourceRoot,
  development = false,
  env = process.env,
  print = () => {},
  provisionUpstreamSkill = defaultProvisionUpstreamSkill
}) {
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options, env);
  print("Checking installation state...");
  ensureSourceSkills(sourceRoot, selection);
  const state = readInstallState(env);
  const grammar = validateStateGrammar(state, env);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths(env).stateFile}: ${grammar.reason}`);
  }
  const requestedChannel = development ? "development" : "release";
  checkChannelGate(state, requestedChannel);
  checkStateCoherence(state, env);
  const upstreamPlans = selectedUpstreamSkillPlans(catalog, selection, state, env);
  const selectedUpstreamNames = new Set(
    selectedUpstreamSkillNames(catalog, selection)
  );
  const installedSkills = [...selection.skills];
  for (const plan of upstreamPlans) {
    if (selectedUpstreamNames.has(plan.name)) installedSkills.push(plan.name);
  }
  const installLauncher = !options.noLauncher;
  const retiredSkills = retiredSkillPlan(catalog, state);
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
  const plan = targetInstallPlan(state, targets, installedSkills, options);
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
    const mode = chooseDeploymentMode({ runtime, targets, development, state, env, print });
    print("Validating staged runtime...");
    const consumerErrors = validateSharedRuntimeConsumers({
      runtime,
      state,
      env,
      mode,
      development,
      installLauncher,
      retireCommandDestinations: retiredCommands.map(entry => entry.destination),
      retireSkillDestinations: retiredSkills.map(entry => entry.destination),
      plannedSkills: installedSkills
    });
    if (consumerErrors.length > 0) fail(consumerErrors.join("\n"));

    if (currentState === null) {
      currentState = {
        schemaVersion: 2,
        channel: requestedChannel,
        releases: [],
        targets: {},
        commands: {}
      };
    }
    transaction = createInstallTransaction();
    const shared = development && mode === "shared";
    const skillSourceRoot = shared ? computePaths(env).currentPath : runtime.root;
    let copiedSkillTargets = 0;
    print(
      `Installing ${installedSkills.length} skill(s) to `
      + `${targets.map(target => target.name).join(", ")}...`
    );

    for (const item of retiredSkills) {
      if (item.owned) {
        transaction.replace([item.destination], () => undefined);
        print(`removed retired skill: ${item.destination}`);
      } else if (item.destinationExists) {
        print(`preserved locally changed retired skill: ${item.destination}`);
      }
      const record = targetState(currentState, item.targetRoot);
      delete record.skills[item.skill];
      updateTargetState(currentState, item.targetRoot, record);
    }

    for (const target of targets) {
      const record = targetState(currentState, target.root);
      for (const item of plan.filter(candidate => candidate.target.name === target.name)) {
        const source = path.join(skillSourceRoot, "skills", item.skill);
        const keepsLink = shared
          && item.record?.mode === "link"
          && item.destinationExists
          && resolvedLinkTarget(item.destination) === source;
        if (!keepsLink) {
          const deployment = transaction.replace([item.destination], () => copyOrLinkSkill({
            source,
            copySource: path.join(runtime.root, "skills", item.skill),
            destination: item.destination,
            link: shared ? "strict" : false,
            print
          }));
          if (deployment.mode === "link") {
            record.skills[item.skill] = { mode: "link", source };
          } else {
            record.skills[item.skill] = { mode: "copy", fingerprint: directoryFingerprint(item.destination) };
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
      transaction.replace(commandArtifactPaths(entry.destination), () => undefined);
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

    addReleaseToInventory(currentState, runtime.id);
    if (currentState.channel === null) currentState.channel = requestedChannel;
    if (mode === "shared") {
      print("Publishing shared runtime...");
      publication = publishRuntime(runtime, currentState, env);
    }
    print("Saving installation state...");
    saveInstallState(currentState, env);
    transaction.commit();
    committed = true;

    const channel = development
      ? (shared ? "shared development link" : "development copy fallback")
      : "release snapshot";
    print("Installed " + installedSkills.length + " skill(s) to " + targets.map(target => target.name).join(", ") + " (" + channel + ").");
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
