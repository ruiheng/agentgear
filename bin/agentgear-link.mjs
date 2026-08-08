#!/usr/bin/env node
import process from "node:process";
import { main } from "../cli/link.mjs";

try {
  main();
} catch (error) {
  process.stderr.write(`agentgear-link: ${error.message}\n`);
  process.exitCode = 1;
}
