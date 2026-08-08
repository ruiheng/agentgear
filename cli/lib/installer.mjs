import fs from "node:fs";
import path from "node:path";
import { resolveSelection } from "./catalog.mjs";
import {
  addReleaseToInventory,
  checkChannelGate,
  checkCommandCollisions,
  checkStateCoherence,
  chooseDeploymentMode,
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
  resolvedLinkTarget,
  rollbackRuntimePublication,
  saveInstallState,
  stageRuntime,
  targetState,
  updateTargetState,
  validateSharedRuntimeConsumers,
  validateStateGrammar
} from "./runtime.mjs";

function fail(message) {
  throw new Error(message);
}

export function selected(catalog, options) {
  return resolveSelection(catalog, {
    packs: options.packs,
    skills: options.skills
  });
}

export function resolveTargetRoots(catalog, options, env = process.env) {
  const names = options.targets.length === 0 ? ["codex"] : options.targets;
  if (options.destination && names.length !== 1) {
    fail("--dest can be used with exactly one --target");
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

function targetInstallPlan(state, targets, selection, options) {
  const errors = [];
  const plan = [];
  for (const target of targets) {
    const recorded = state === null ? { skills: {} } : targetState(state, target.root);
    for (const skill of selection.skills) {
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

export function installSelection({
  catalog,
  options,
  sourceRoot,
  development = false,
  env = process.env,
  print
}) {
  const selection = selected(catalog, options);
  const targets = resolveTargetRoots(catalog, options, env);
  ensureSourceSkills(sourceRoot, selection);
  const state = readInstallState(env);
  const grammar = validateStateGrammar(state, env);
  if (!grammar.valid) {
    fail(`Invalid installation state ${computePaths(env).stateFile}: ${grammar.reason}`);
  }
  const requestedChannel = development ? "development" : "release";
  checkChannelGate(state, requestedChannel);
  checkStateCoherence(state, env);
  const installLauncher = !options.noLauncher;
  const installWorkflowHelpers = installLauncher && selection.skills.includes("multi-agent-protocol");
  const plan = targetInstallPlan(state, targets, selection, options);
  checkCommandCollisions(state, env, installLauncher, installWorkflowHelpers, options.force);

  let currentState = state;
  let runtime;
  let publication;
  let transaction;
  let committed = false;

  try {
    runtime = stageRuntime({ sourceRoot, env });
    const mode = chooseDeploymentMode({ runtime, targets, development, state, env, print });
    const consumerErrors = validateSharedRuntimeConsumers({
      runtime,
      state,
      env,
      mode,
      development,
      installLauncher,
      installWorkflowHelpers,
      plannedSkills: selection.skills
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

    if (installLauncher) {
      for (const entry of commandEntries(env)) {
        if (entry.kind === "workflow-helper" && !installWorkflowHelpers) continue;
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
      publication = publishRuntime(runtime, currentState, env);
    }
    saveInstallState(currentState, env);
    transaction.commit();
    committed = true;

    const channel = development
      ? (shared ? "shared development link" : "development copy fallback")
      : "release snapshot";
    print("Installed " + selection.skills.length + " skill(s) to " + targets.map(target => target.name).join(", ") + " (" + channel + ").");
    if (copiedSkillTargets > 0) {
      print("Copied " + copiedSkillTargets + " skill(s) because links are unavailable at their destination.");
    }
    if (selection.requirements.commands.length > 0) {
      print("Run: agentgear doctor --pack " + selection.packs.at(-1));
    }
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
