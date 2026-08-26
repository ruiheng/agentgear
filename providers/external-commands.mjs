import fs from "node:fs";
import path from "node:path";

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DEFAULT_WINDOWS_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

function windowsExtensions(command, env) {
  if (path.win32.extname(command)) return [""];
  const source = String(env.PATHEXT || DEFAULT_WINDOWS_EXTENSIONS.join(";"));
  const result = [...new Set(source.split(";")
    .filter(segment => /^\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment))
    .map(segment => segment.toUpperCase()))];
  return result.length > 0 ? result : DEFAULT_WINDOWS_EXTENSIONS;
}

export function resolveExternalCommand(command, {
  env = process.env,
  platform = process.platform,
  stat = fs.statSync,
  access = fs.accessSync
} = {}) {
  if (typeof command !== "string" || !COMMAND_NAME.test(command)) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  const extensions = platform === "win32" ? windowsExtensions(command, env) : [""];
  for (const rawDirectory of String(env.PATH ?? "").split(delimiter)) {
    if (!rawDirectory) continue;
    const directory = pathApi.resolve(rawDirectory);

    for (const extension of extensions) {
      const candidate = pathApi.join(directory, command + extension);
      try {
        if (!stat(candidate).isFile()) continue;
        access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // An unavailable or racing PATH entry is only a missing capability hint.
      }
    }
  }
  return null;
}

export function isCommandAvailable(command, env = process.env) {
  return resolveExternalCommand(command, { env }) !== null;
}

function codeGraphDirectoryName(env) {
  const candidate = String(env.CODEGRAPH_DIR ?? "").trim();
  if (!candidate) return ".codegraph";
  if (
    candidate === "."
    || candidate.includes("..")
    || candidate.includes("/")
    || candidate.includes("\\")
    || path.isAbsolute(candidate)
  ) {
    return ".codegraph";
  }
  return candidate;
}

export function codeGraphIndexReady(workdir, {
  env = process.env,
  stat = fs.statSync
} = {}) {
  const directoryName = codeGraphDirectoryName(env);
  let current = path.resolve(workdir);
  while (true) {
    try {
      const dataDirectory = path.join(current, directoryName);
      if (stat(dataDirectory).isDirectory() && stat(path.join(dataDirectory, "codegraph.db")).isFile()) {
        return true;
      }
    } catch {
      // Keep walking toward the filesystem root, like CodeGraph project discovery.
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function readyExternalCommands(commandDefinitions, {
  workdir = process.cwd(),
  env = process.env,
  platform = process.platform,
  stat = fs.statSync,
  access = fs.accessSync
} = {}) {
  const ready = new Set();
  for (const definition of commandDefinitions) {
    if (!resolveExternalCommand(definition.name, { env, platform, stat, access })) continue;
    if (definition.readiness === "codegraph-index" && !codeGraphIndexReady(workdir, { env, stat })) continue;
    ready.add(definition.name);
  }
  return ready;
}
