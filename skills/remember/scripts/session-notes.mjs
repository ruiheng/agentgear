#!/usr/bin/env node

// Queues a session-notes op in the cwd-keyed inbox. The session hook claims
// it on the next hook event and applies it to this session's notes. Queued
// does not mean applied: watch for the `Session notes pinned by the user`
// block or hook output as confirmation.

import { appendInboxOp, noteCommandOp, readInboxOps } from "../../multi-agent-protocol/scripts/session-notes-store.mjs";

function usage() {
  return [
    "Usage: session-notes.mjs <command>",
    "  add <text>          pin a note for this session",
    "  remove <N|text>     remove by number from the pinned block or exact text",
    "  clear               remove all session notes",
    "  list                echo the pinned notes at the next hook event",
    "  pending             show ops not yet claimed by the session hook"
  ].join("\n");
}

function queued(op) {
  const file = appendInboxOp(process.cwd(), op);
  process.stdout.write(`queued ${JSON.stringify(op)} for this session (inbox: ${file})\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (command === "pending") {
  const ops = readInboxOps(process.cwd());
  process.stdout.write(ops.length === 0 ? "no pending ops\n" : `${ops.map(op => JSON.stringify(op)).join("\n")}\n`);
  process.exit(0);
}
const result = noteCommandOp(command.toLowerCase(), rest.join(" "));
if (result.error) {
  process.stderr.write(`session-notes: ${result.error}\n${usage()}\n`);
  process.exit(2);
}
queued(result.op);
