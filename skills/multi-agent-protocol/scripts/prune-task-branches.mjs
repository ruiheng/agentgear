#!/usr/bin/env node
import process from "node:process";
import { execute, fail, isMain, parseArgs, run } from "./workflow-lib.mjs";

const usage = `Prune stale task branches using "keep recent N + ancestor of current base" policy.

Usage:
  prune-task-branches.mjs [options]

Options:
  --keep N          Keep newest N task branches (default: 10)
  --prefix PREFIX   Branch prefix to scan (default: task/)
  --base REF        Base ref for ancestor check (default: HEAD)
  --apply           Execute deletion (default: dry-run only)
  -h, --help        Show this help`;

function git(args) {
  return run("git", args);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    values: ["--keep", "--prefix", "--base"],
    flags: ["--apply"],
    defaults: { keep: "10", prefix: "task/", base: "HEAD", apply: false }
  });
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!/^\d+$/.test(options.keep)) fail(`--keep must be a non-negative integer, got: ${options.keep}`, 1, "[ERR]");
  const keep = Number(options.keep);
  if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) fail("Not inside a git repository.", 1, "[ERR]");
  if (git(["rev-parse", "--verify", options.base]).status !== 0) fail(`Base ref does not exist: ${options.base}`, 1, "[ERR]");

  const currentBranchResult = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const currentBranch = currentBranchResult.status === 0 ? currentBranchResult.stdout.trim() : "";
  const listed = git([
    "for-each-ref", "--sort=-committerdate",
    "--format=%(refname:short)|%(committerdate:short)|%(committerdate:unix)",
    `refs/heads/${options.prefix}*`
  ]);
  const branches = listed.status === 0
    ? listed.stdout.trim().split("\n").filter(Boolean).map(line => {
      const [branch, date] = line.split("|");
      return { branch, date };
    })
    : [];

  process.stdout.write(`[INFO] prefix=${options.prefix} keep=${keep} base=${options.base} mode=${options.apply ? "apply" : "dry-run"}\n`);
  process.stdout.write(`[INFO] matched task branches: ${branches.length}\n`);
  if (branches.length === 0) {
    process.stdout.write("[OK] Nothing to do.\n");
    return;
  }

  const rows = branches.map(({ branch, date }, index) => {
    let action = "keep";
    let reason = `recent_top_${keep}`;
    if (branch === currentBranch) reason = "current_branch";
    else if (index + 1 > keep) {
      if (git(["merge-base", "--is-ancestor", branch, options.base]).status === 0) {
        action = "delete";
        reason = `ancestor_of_${options.base}`;
      } else {
        reason = `not_ancestor_of_${options.base}`;
      }
    }
    return { action, branch, date, reason };
  });
  const pad = (text, width) => String(text).padEnd(width, " ");
  process.stdout.write(`\n${pad("ACTION", 8)}  ${pad("BRANCH", 40)}  ${pad("DATE", 10)}  REASON\n`);
  process.stdout.write(`${pad("------", 8)}  ${pad("------", 40)}  ${pad("----", 10)}  ------\n`);
  for (const row of rows) process.stdout.write(`${pad(row.action, 8)}  ${pad(row.branch, 40)}  ${pad(row.date, 10)}  ${row.reason}\n`);

  const candidates = rows.filter(row => row.action === "delete");
  process.stdout.write(`\n[INFO] delete candidates: ${candidates.length}\n`);
  if (!options.apply) {
    process.stdout.write("[DRY-RUN] No branches deleted. Re-run with --apply to execute.\n");
    return;
  }
  let deleted = 0;
  let failed = 0;
  for (const { branch } of candidates) {
    if (git(["branch", "-d", branch]).status === 0) {
      process.stdout.write(`[DEL] ${branch}\n`);
      deleted += 1;
    } else {
      process.stdout.write(`[WARN] Failed to delete with -d: ${branch} (left unchanged)\n`);
      failed += 1;
    }
  }
  process.stdout.write(`[OK] deletion complete: deleted=${deleted} failed=${failed}\n`);
}

if (isMain(import.meta.url)) execute(() => main());
