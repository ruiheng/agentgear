import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_REPLACE_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "[System.IO.File]::Replace($env:AGENTGEAR_REPLACEMENT_PATH, $env:AGENTGEAR_DESTINATION_PATH, $env:AGENTGEAR_BACKUP_PATH, $true)"
].join("; ");

function windowsPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (!systemRoot) throw new Error("Cannot atomically replace a Windows file: SystemRoot is unavailable");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Cannot atomically replace a Windows file: PowerShell is unavailable at ${executable}`);
  }
  return executable;
}

function replaceExistingWindowsFileSync(temporaryPath, destinationPath, env) {
  const backupPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.replace-backup`
  );
  const result = childProcess.spawnSync(windowsPowerShellPath(env), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REPLACE_COMMAND
  ], {
    encoding: "utf8",
    env: {
      ...env,
      AGENTGEAR_REPLACEMENT_PATH: temporaryPath,
      AGENTGEAR_DESTINATION_PATH: destinationPath,
      AGENTGEAR_BACKUP_PATH: backupPath
    },
    timeout: 30000,
    windowsHide: true
  });
  if (result.error) {
    throw new Error(`Cannot atomically replace Windows file ${destinationPath}: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `Cannot atomically replace Windows file ${destinationPath}: ${detail || `PowerShell exited with status ${result.status}`}`
    );
  }
  try {
    fs.rmSync(backupPath);
  } catch (error) {
    throw new Error(`Replaced Windows file ${destinationPath} but could not remove backup ${backupPath}: ${error.message}`, {
      cause: error
    });
  }
}

export function commitTemporaryFileSync(temporaryPath, destinationPath, {
  platform = process.platform,
  env = process.env
} = {}) {
  const destination = fs.lstatSync(destinationPath, { throwIfNoEntry: false });
  if (platform === "win32" && destination?.isFile() && !destination.isSymbolicLink()) {
    replaceExistingWindowsFileSync(temporaryPath, destinationPath, env);
    return;
  }
  fs.renameSync(temporaryPath, destinationPath);
}
