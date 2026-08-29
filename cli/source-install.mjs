#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPacks, loadCatalog } from "./lib/catalog.mjs";
import { refreshInstalledCodexHooks } from "./lib/codex-hooks.mjs";
import { DEFAULT_TARGETS, installSelection } from "./lib/installer.mjs";
import { isReleaseSnapshot } from "./lib/runtime.mjs";
import { parseOptions } from "./lib/options.mjs";

const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const rootDir = path.resolve(path.dirname(thisFile), "..");
const SOURCE_CHECKOUT_MARKER = ".agentgear-source-checkout";

function print(message = "") {
  process.stdout.write(String(message) + "\n");
}

function usage(catalog) {
  return [
    "Usage: agentgear-source-install [options]",
    "",
    "Install this source checkout into Agentgear's shared runtime.",
    "Rerun the same command from this checkout after source changes.",
    "",
    "Options:",
    "  --pack NAME                 Install one or more packs (default: all).",
    "  --skill NAME                Install named skills when --pack is omitted (default: none).",
    `  --target NAME[,NAME]       Select destinations (default: ${DEFAULT_TARGETS.join(",")}).`,
    "  --scope global|project      Use global or project destinations (default: global).",
    "  --project DIR               Project root for --scope project (default: current directory).",
    "  --dest DIR                  Override one destination directory (default: none; defaults to general).",
    "  --prefix PREFIX             Prefix installed discovery skill names (default: recorded or none).",
    "  --force                     Replace selected conflicting artifacts (default: false).",
    "  --no-launcher               Skip the global agentgear command (default: false).",
    "  -h, --help                  Show this help (default: false).",
    "",
    "Available packs:",
    ...listPacks(catalog).map(pack => `  ${pack.name.padEnd(10)} ${pack.description}`),
    "",
    "Available targets:",
    ...Object.entries(catalog.targets.targets).map(([name, target]) =>
      `  ${name.padEnd(10)} ${target.description}`)
  ].join("\n");
}

function requireSourceCheckout() {
  if (isReleaseSnapshot(rootDir)) {
    throw new Error(
      "agentgear-source-install must be run from a source checkout, not a staged runtime. "
      + "Run: node /path/to/agentgear/bin/agentgear-source-install.mjs ..."
    );
  }
  const markerPath = path.join(rootDir, SOURCE_CHECKOUT_MARKER);
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (markerInfo?.isFile() && !markerInfo.isSymbolicLink()) return;
  throw new Error(
    "agentgear-source-install must be run from a source checkout. "
    + "Clone Agentgear, then run: node /path/to/agentgear/bin/agentgear-source-install.mjs ..."
  );
}

export function main(argumentsList = process.argv.slice(2)) {
  const options = parseOptions(argumentsList);
  const catalog = loadCatalog(rootDir);
  if (options.help) {
    print(usage(catalog));
    return;
  }
  if (options.purge) throw new Error("--purge is only valid with agentgear uninstall");
  if (options.json) throw new Error("--json is not supported by agentgear-source-install");
  if (options.positional.length > 0) throw new Error("Unknown argument: " + options.positional[0]);
  requireSourceCheckout();
  installSelection({
    catalog,
    options,
    sourceRoot: rootDir,
    sourceInstall: true,
    print
  });
  refreshInstalledCodexHooks({ print });
}

export { rootDir };

const invokedFile = process.argv[1] && fs.realpathSync(process.argv[1], { throwIfNoEntry: false });
if (invokedFile === thisFile) {
  try {
    main();
  } catch (error) {
    process.stderr.write("agentgear-source-install: " + error.message + "\n");
    process.exitCode = 1;
  }
}
