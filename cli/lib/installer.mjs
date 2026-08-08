import fs from "node:fs";
import path from "node:path";
import { resolveSelection } from "./catalog.mjs";
import {
  copyOrLinkSkill,
  createInstallTransaction,
  destinationMatchesRecord,
  directoryFingerprint,
  ensureLauncher,
  ensureWorkflowHelpers,
  exists,
  expandHome,
  getDataRoot,
  discardRuntime,
  linkTargetsPath,
  publishRuntime,
  readInstallState,
  recordRuntimeCommand,
  rollbackRuntimePublication,
  saveInstallState,
  stageRuntime,
  targetState,
  updateTargetState,
  validateSharedRuntimeConsumers,
  verifiedLegacyDevelopmentSourceRoots
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

function targetInstallPlan(state, targets, selection, sourceRoot, options) {
  const errors = [];
  const plan = [];
  for (const target of targets) {
    const recorded = targetState(state, target.root);
    for (const skill of selection.skills) {
      const source = path.join(sourceRoot, "skills", skill);
      const destination = path.join(target.root, skill);
      const record = recorded.skills[skill];
      const destinationExists = exists(destination);
      if (destinationExists && !record && !options.force) {
        errors.push("Unmanaged skill already exists: " + destination);
      } else if (destinationExists && record && !destinationMatchesRecord(destination, record) && !options.force) {
        errors.push("Installer-managed skill changed locally: " + destination + " (use --force to replace it)");
      }
      plan.push({ target, skill, source, destination, record, destinationExists });
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
  const legacySourceRoots = verifiedLegacyDevelopmentSourceRoots(state, env);
  const plannedSourceRoot = development ? path.join(getDataRoot(env), "current") : sourceRoot;
  const plan = targetInstallPlan(state, targets, selection, plannedSourceRoot, options);
  let runtime;
  let publication;
  let transaction;
  let committed = false;

  try {
    runtime = stageRuntime({ sourceRoot, env });
    const consumerErrors = validateSharedRuntimeConsumers({
      runtime,
      state,
      snapshotRoot: runtime.root,
      env,
      installLauncher: !options.noLauncher,
      installWorkflowHelpers: !options.noLauncher && selection.skills.includes("agent-deck-workflow"),
      plannedSkills: selection.skills
    });
    if (consumerErrors.length > 0) fail(consumerErrors.join("\n"));
    transaction = createInstallTransaction();
    const linksRequested = development && Boolean(runtime.sharedRoot);
    const source = linksRequested ? runtime.sharedRoot : runtime.root;
    for (const item of plan) {
      item.source = path.join(source, "skills", item.skill);
      item.copySource = path.join(runtime.root, "skills", item.skill);
      item.link = linksRequested;
    }

    let copiedLinkTargets = 0;
    for (const target of targets) {
      const record = targetState(state, target.root);
      for (const item of plan.filter(candidate => candidate.target.name === target.name)) {
        const keepsSharedLink = !options.force
          && item.link
          && item.destinationExists
          && item.record?.mode === "link"
          && linkTargetsPath(item.destination, item.source)
          && destinationMatchesRecord(item.destination, {
            ...item.record,
            source: path.resolve(item.source)
          });
        let deployment = { mode: "link" };
        if (!keepsSharedLink) {
          deployment = transaction.replace([item.destination], () => copyOrLinkSkill({
            source: item.source,
            copySource: item.copySource,
            destination: item.destination,
            link: item.link,
            print
          }));
          if (item.link && deployment.mode === "copy") copiedLinkTargets += 1;
        }
        const copied = deployment.mode === "copy";
        record.skills[item.skill] = {
          source: copied ? fs.realpathSync(item.copySource) : path.resolve(item.source),
          mode: deployment.mode,
          fingerprint: copied ? directoryFingerprint(item.copySource) : null,
          runtimeId: runtime.id,
          installedAt: new Date().toISOString()
        };
      }
      updateTargetState(state, target.root, record);
    }

    if (!options.noLauncher) {
      const launcher = ensureLauncher({
        sourceRoot,
        runtime,
        state,
        legacySourceRoots,
        force: options.force,
        env,
        print,
        transaction
      });
      recordRuntimeCommand(state, launcher);
      if (selection.skills.includes("agent-deck-workflow")) {
        const helpers = ensureWorkflowHelpers({
          sourceRoot,
          runtime,
          state,
          legacySourceRoots,
          force: options.force,
          env,
          print,
          transaction
        });
        for (const helper of helpers) recordRuntimeCommand(state, helper);
      }
    }

    publication = publishRuntime(runtime);
    saveInstallState(state, env);
    transaction.commit();
    committed = true;

    const channel = development
      ? (runtime.sharedRoot ? "shared development link" : "shared development copy fallback")
      : "release snapshot";
    print("Installed " + selection.skills.length + " skill(s) to " + targets.map(target => target.name).join(", ") + " (" + channel + ").");
    if (copiedLinkTargets > 0) {
      print("Copied " + copiedLinkTargets + " skill(s) because links are unavailable at their destination.");
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
        error.message += "; additionally failed to restore the previous shared runtime: " + rollbackError.message;
      }
    }
    if (!committed && transaction) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        rollbackSucceeded = false;
        error.message += "; additionally failed to restore installation paths: " + rollbackError.message;
      }
    }
    if (!committed && runtime && rollbackSucceeded) discardRuntime(runtime);
    throw error;
  }
}
