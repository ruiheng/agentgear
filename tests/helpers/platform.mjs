import fs from "node:fs";
import path from "node:path";

export function linkDirectory(target, destination) {
  fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}

export function nodeCommandPath(directory, name) {
  return path.join(directory, process.platform === "win32" ? `${name}.cmd` : name);
}

export function writeNodeCommand(directory, name, source) {
  fs.mkdirSync(directory, { recursive: true });
  const command = nodeCommandPath(directory, name);
  if (process.platform === "win32") {
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`);
    fs.writeFileSync(path.join(directory, `${name}.cjs`), source);
  } else {
    fs.writeFileSync(command, `#!${process.execPath}\n${source}\n`);
    fs.chmodSync(command, 0o755);
  }
  return command;
}
