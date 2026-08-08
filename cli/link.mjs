#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./lib/catalog.mjs";
import { installSelection } from "./lib/installer.mjs";
import { parseOptions } from "./lib/options.mjs";

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const rootDir = path.resolve(path.dirname(thisFile), "..");
const DEVELOPMENT_MARKER = ".agentgear-dev-checkout";

function print(message = "") {
  process.stdout.write(String(message) + "\n");
}

function usage() {
  return [
    "Usage: agentgear-link [options]",
    "",
    "Snapshot this development checkout into Agentgear's shared runtime.",
    "Rerun the same command from this checkout after local edits.",
    "",
    "Options:",
    "  --pack NAME",
    "  --skill NAME",
    "  --target NAME[,NAME]",
    "  --scope global|project",
    "  --project DIR",
    "  --dest DIR",
    "  --force",
    "  --no-launcher"
  ].join("\n");
}

function isRuntimeSnapshot(contentRoot) {
  const markerPath = path.join(contentRoot, ".agentgear-runtime.json");
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return marker.schemaVersion === 1 && typeof marker.releaseId === "string";
  } catch {
    return false;
  }
}

function requireDevelopmentCheckout() {
  if (isRuntimeSnapshot(rootDir)) {
    throw new Error(
      "agentgear-link must be run from a development checkout, not a staged runtime. "
      + "Run: node /path/to/agentgear/bin/agentgear-link.mjs ..."
    );
  }
  const markerPath = path.join(rootDir, DEVELOPMENT_MARKER);
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (markerInfo?.isFile() && !markerInfo.isSymbolicLink()) return;
  throw new Error(
    "agentgear-link must be run from a development checkout. "
    + "Clone Agentgear, then run: node /path/to/agentgear/bin/agentgear-link.mjs ..."
  );
}

export function main(argumentsList = process.argv.slice(2)) {
  const options = parseOptions(argumentsList);
  if (options.help) {
    print(usage());
    return;
  }
  if (options.purge) throw new Error("--purge is only valid with agentgear uninstall");
  if (options.json) throw new Error("--json is not supported by agentgear-link");
  if (options.positional.length > 0) throw new Error("Unknown argument: " + options.positional[0]);
  requireDevelopmentCheckout();
  const catalog = loadCatalog(rootDir);
  installSelection({
    catalog,
    options,
    sourceRoot: rootDir,
    development: true,
    print
  });
}

export { rootDir };

const invokedFile = process.argv[1] && fs.realpathSync(process.argv[1], { throwIfNoEntry: false });
if (invokedFile === thisFile) {
  try {
    main();
  } catch (error) {
    process.stderr.write("agentgear-link: " + error.message + "\n");
    process.exitCode = 1;
  }
}
