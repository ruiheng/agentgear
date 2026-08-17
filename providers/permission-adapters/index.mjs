import { agyAdapter } from "./agy.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { geminiAdapter } from "./gemini.mjs";

export const permissionAdapters = new Map([
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  agyAdapter
].map(adapter => [adapter.name, adapter]));
