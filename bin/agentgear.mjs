#!/usr/bin/env node
import process from "node:process";
import { main } from "../cli/agentgear.mjs";

try {
  main();
} catch (error) {
  process.stderr.write(`agentgear: ${error.message}\n`);
  process.exitCode = 1;
}
