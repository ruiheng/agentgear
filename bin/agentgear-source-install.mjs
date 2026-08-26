#!/usr/bin/env node
import process from "node:process";
import { main } from "../cli/source-install.mjs";

try {
  main();
} catch (error) {
  process.stderr.write(`agentgear-source-install: ${error.message}\n`);
  process.exitCode = 1;
}
