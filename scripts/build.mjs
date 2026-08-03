import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../cli/ai-skills.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(rootDir);
main(["build"]);
