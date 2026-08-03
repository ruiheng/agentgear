#!/usr/bin/env node
import process from "node:process";
import { main } from "../cli/ai-skills.mjs";

try {
  main();
} catch (error) {
  process.stderr.write(`ai-skills: ${error.message}\n`);
  process.exitCode = 1;
}
