import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareIncrementalReview } from "../skills/review-tech-design/scripts/prepare-incremental-review.mjs";

function git(repository, args) {
  const result = childProcess.spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentgear-design-review-"));
  const repository = path.join(temporary, "repository");
  fs.mkdirSync(repository);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test User"]);
  fs.mkdirSync(path.join(repository, "src"));
  fs.writeFileSync(path.join(repository, "src", "owner.js"), "export const owner = 'requester';\n");
  git(repository, ["add", "src/owner.js"]);
  git(repository, ["commit", "-qm", "initial"]);
  const designRoot = path.join(repository, ".agent-artifacts", "design-spec", "author-1");
  fs.mkdirSync(designRoot, { recursive: true });
  fs.writeFileSync(path.join(designRoot, "r001.md"), "# Design\n\nUse the requester-owned route.\n");
  return { temporary, repository, designRoot };
}

function options(repository, round, extra = {}) {
  return {
    workdir: repository,
    taskId: "design-task",
    reviewerSessionId: "reviewer-1",
    round: String(round),
    currentArtifact: `.agent-artifacts/design-spec/author-1/r${String(round).padStart(3, "0")}.md`,
    recordEvidence: [],
    ...extra,
  };
}

test("round one creates reviewer-owned evidence and ledger state", () => {
  const current = fixture();
  try {
    const result = prepareIncrementalReview(options(current.repository, 1, {
      recordEvidence: ["src/owner.js"],
    }));
    assert.equal(result.round, 1);
    assert.equal(result.previous_artifact, null);
    assert.equal(result.diff_file, null);
    assert.deepEqual(result.stale_evidence, []);
    const stateRoot = path.join(current.repository, ".agent-artifacts", "design-review", "reviewer-1", "design-task");
    assert.equal(fs.existsSync(path.join(stateRoot, "evidence-index.md")), true);
    assert.equal(fs.existsSync(path.join(stateRoot, "review-ledger.md")), true);
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "review-state.json"), "utf8"));
    assert.match(state.evidence_files["src/owner.js"].sha256, /^[a-f0-9]{64}$/);
    assert.equal(state.rounds["1"].current_artifact, ".agent-artifacts/design-spec/author-1/r001.md");
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("later rounds require the exact prepared predecessor and generate a machine diff", () => {
  const current = fixture();
  try {
    prepareIncrementalReview(options(current.repository, 1));
    fs.writeFileSync(path.join(current.designRoot, "r002.md"), "# Design\n\nUse the canonical requester-owned route.\n");
    const result = prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    }));
    assert.equal(result.previous_artifact, ".agent-artifacts/design-spec/author-1/r001.md");
    assert.equal(result.diff_empty, false);
    const diff = fs.readFileSync(path.join(current.repository, result.diff_file), "utf8");
    assert.match(diff, /requester-owned route/);
    assert.match(diff, /canonical requester-owned route/);

    fs.writeFileSync(path.join(current.designRoot, "r003.md"), "# Design\n\nThird round.\n");
    assert.throws(() => prepareIncrementalReview(options(current.repository, 3, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    })), /--previous-artifact must equal .*r002\.md/);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("changed evidence is reported stale until the reviewer records it again", () => {
  const current = fixture();
  try {
    prepareIncrementalReview(options(current.repository, 1, { recordEvidence: ["src/owner.js"] }));
    fs.writeFileSync(path.join(current.repository, "src", "owner.js"), "export const owner = 'reviewer';\n");
    fs.writeFileSync(path.join(current.designRoot, "r002.md"), "# Design\n\nUse the requester-owned route.\n");
    const stale = prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    }));
    assert.deepEqual(stale.stale_evidence.map(entry => [entry.path, entry.reason]), [
      ["src/owner.js", "content_changed"],
    ]);

    const refreshed = prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
      recordEvidence: ["src/owner.js"],
    }));
    assert.equal(refreshed.stale_evidence_before_recording.length, 1);
    assert.deepEqual(refreshed.stale_evidence, []);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("prepared artifacts are immutable review baselines", () => {
  const current = fixture();
  try {
    prepareIncrementalReview(options(current.repository, 1));
    fs.appendFileSync(path.join(current.designRoot, "r001.md"), "Modified after dispatch.\n");
    assert.throws(() => prepareIncrementalReview(options(current.repository, 1)), /different immutable target or baseline/);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("evidence paths must be regular repository files", () => {
  const current = fixture();
  try {
    assert.throws(() => prepareIncrementalReview(options(current.repository, 1, {
      recordEvidence: [".agent-artifacts/design-spec/author-1/r001.md"],
    })), /repository evidence/);
    assert.throws(() => prepareIncrementalReview(options(current.repository, 1, {
      recordEvidence: ["../outside.txt"],
    })), /inside --workdir/);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("reviewer state writes reject generated diff and ledger symlinks", { skip: process.platform === "win32" }, () => {
  const current = fixture();
  const outside = path.join(current.temporary, "outside.txt");
  try {
    prepareIncrementalReview(options(current.repository, 1));
    fs.writeFileSync(path.join(current.designRoot, "r002.md"), "# Design\n\nSecond round.\n");
    const stateRoot = path.join(current.repository, ".agent-artifacts", "design-review", "reviewer-1", "design-task");
    const diffFile = path.join(stateRoot, "r002-from-r001.diff");
    fs.symlinkSync(outside, diffFile);
    assert.throws(() => prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    })), /generated review output must be a regular file/);
    assert.equal(fs.lstatSync(diffFile).isSymbolicLink(), true);
    assert.equal(fs.existsSync(outside), false);

    fs.rmSync(diffFile);
    prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    }));
    fs.rmSync(path.join(stateRoot, "review-ledger.md"));
    fs.symlinkSync(outside, path.join(stateRoot, "review-ledger.md"));
    assert.throws(() => prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    })), /Review Ledger must be a regular file/);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("untracked repository files change the later-round worktree fingerprint", () => {
  const current = fixture();
  try {
    prepareIncrementalReview(options(current.repository, 1));
    fs.writeFileSync(path.join(current.repository, "src", "new-owner.js"), "export const owner = 'new';\n");
    fs.writeFileSync(path.join(current.designRoot, "r002.md"), "# Design\n\nSecond round.\n");
    const result = prepareIncrementalReview(options(current.repository, 2, {
      previousArtifact: ".agent-artifacts/design-spec/author-1/r001.md",
    }));
    assert.equal(result.worktree_changed, true);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});
