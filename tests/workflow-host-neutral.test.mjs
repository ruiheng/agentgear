import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

const creationSkills = [
  "delegate-code-task",
  "delegate-task",
  "dispatch-plan",
  "review-request",
  "refactor-review-request",
  "browser-test-request",
  "tech-design-workflow",
  "roundtable",
];

test("generic creation skills do not embed Agent Deck routing", () => {
  for (const name of creationSkills) {
    const source = [
      read(`skills/${name}/SKILL.md`),
      ...fs.readdirSync(path.join(rootDir, "skills", name, "references"), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
        .map(entry => read(`skills/${name}/references/${entry.name}`))
    ].join("\n");
    assert.match(source, /session_(?:resolve|require|create)|session-host/);
    assert.doesNotMatch(source, /agent_deck_(?:create|require|resolve)_session/);
    assert.doesNotMatch(source, /agent-deck\//);
    assert.doesNotMatch(source, /\bensure_cmd\b/);
    assert.doesNotMatch(source, /\bgroup_path\b/);
    assert.doesNotMatch(source, /\bstartup_instruction\b/);
  }
});

test("the shared contract uses resolver-provided launch values", () => {
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  const resolverContract = read("skills/multi-agent-protocol/references/tool-resolution.md");
  assert.match(hostContract, /full_command_line/);
  assert.match(hostContract, /thurbox_agent_key/);
  assert.doesNotMatch(hostContract, /launch_profile/);
  assert.doesNotMatch(hostContract, /session-host-config/);
  assert.match(resolverContract, /tool_candidates/);
  assert.match(resolverContract, /thurbox_agent_key/);
});

test("the shared contract does not auto-repair unverified wake hints", () => {
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  const sharedProtocol = read("skills/multi-agent-protocol/references/internal-protocol/shared-protocol.md");
  for (const source of [hostContract, sharedProtocol]) {
    assert.match(source, /false\s+negative/);
    assert.match(source, /Do not resend, press\s+Enter, restart, inspect, or (?:otherwise )?repair/);
    assert.match(source, /explicitly\s+authorizes troubleshooting/);
  }
});

test("generic workflow scripts require explicit Waypost routes", () => {
  for (const name of [
    "acquire-active-task-lock.mjs",
    "send-delegate-with-active-task-lock.mjs",
    "prepare-workspaces.mjs",
    "planner-closeout-batch.mjs",
  ]) {
    const source = read(`skills/multi-agent-protocol/scripts/${name}`);
    assert.doesNotMatch(source, /\bagent-deck\b/);
  }
  const sender = read("skills/multi-agent-protocol/scripts/send-delegate-with-active-task-lock.mjs");
  assert.match(sender, /--from-address/);
  assert.match(sender, /--to-address/);
});

test("closeout documents exact task-session cleanup ownership", () => {
  const plannerCloseout = read("skills/planner-closeout/references/disclosure-start.md");
  const delegateCode = [
    read("skills/delegate-code-task/references/disclosure-start.md"),
    read("skills/delegate-code-task/references/dispatch.md"),
    read("skills/delegate-code-task/references/disclosure-continue-1.md"),
    read("skills/delegate-code-task/references/disclosure-continue-2.md")
  ].join("\n");
  const hostContract = read("skills/multi-agent-protocol/references/session-host.md");
  assert.match(plannerCloseout, /--coder-session-id <coder_session_id>/);
  assert.match(plannerCloseout, /--reviewer-session-id <reviewer_session_id>/);
  assert.match(plannerCloseout, /--session-host <session_host>/);
  assert.match(delegateCode, /task-scoped coder/);
  assert.match(hostContract, /exact recorded ids/);
  assert.doesNotMatch(plannerCloseout, /Generic workflow code does not remove or rehome host sessions/);
});

test("shared cleanup uses generic targets and provider-owned host behavior", () => {
  const cleanupPath = path.join(rootDir, "skills/multi-agent-protocol/scripts/archive-and-remove-task-sessions.mjs");
  const cleanup = fs.readFileSync(cleanupPath, "utf8");
  const provider = read("providers/session-cleanup.mjs");
  const plannerBatch = read("skills/multi-agent-protocol/scripts/planner-closeout-batch.mjs");
  if (process.platform !== "win32") assert.notEqual(fs.statSync(cleanupPath).mode & 0o111, 0);
  assert.match(cleanup, /--target <role>=<session-id>/);
  assert.match(cleanup, /repeatableValues: \["--target"\]/);
  assert.doesNotMatch(cleanup, /sqlite3|thurbox-cli|agent-deck remove|group.*delete/);
  assert.match(provider, /thurbox-cli/);
  assert.match(provider, /providerIdsFromStateDatabase/);
  assert.match(plannerBatch, /cleanupArgs\.push\("--target"/);
});

test("technical design requester owns terminal architect cleanup", () => {
  const workflow = read("skills/tech-design-workflow/references/disclosure-start.md");
  const draftStart = read("skills/tech-design-workflow/references/draft-review-start.md");
  const authorRound = read("skills/tech-design-workflow/references/author-round.md");
  const reportHandling = read("skills/tech-design-workflow/references/report-handling.md");
  const requesterHandling = read("skills/tech-design-workflow/references/requester-handling.md");
  const requesterDelivery = read("skills/tech-design-workflow/references/requester-delivery.md");
  const closeout = read("skills/tech-design-workflow/references/closeout.md");
  const reviewer = read("skills/review-tech-design/references/disclosure-start.md");
  const contextIntake = read("skills/review-tech-design/references/context-intake.md");
  const draftReview = read("skills/review-tech-design/references/draft-round-review.md");
  const reviewDelivery = read("skills/review-tech-design/references/message-delivery.md");
  const messageRouter = read("skills/check-waypost-messages/references/disclosure-start.md");
  assert.match(closeout, /requester that receives the terminal delivery or review report owns successful closeout/);
  assert.match(workflow, /Canonical Design Task Contract/);
  assert.match(draftStart, /agentgear run tech-design-workflow send-design-draft-with-review-context\.mjs/);
  assert.match(draftStart, /reviewer-first ordering/);
  assert.match(authorRound, /Session Host: <session_host>/);
  assert.match(authorRound, /Previous reviewed artifact/);
  assert.match(authorRound, /Reuse prior evidence from unchanged source/);
  assert.match(authorRound, /machine diff/);
  assert.match(requesterHandling, /send the same delta unchanged to author/);
  assert.match(requesterHandling, /design_spec_review_context_rejected/);
  assert.match(workflow, /design_spec_context_corrected/);
  assert.match(workflow, /design_spec_review_context_recovery_requested/);
  assert.match(authorRound, /Do not supply, reconstruct, or summarize requester context/);
  assert.match(requesterHandling, /add `Recovery Complete: yes` only to the last envelope/);
  assert.match(requesterHandling, /send every corrected shared lane field to the author/);
  assert.match(reviewer, /Action: design_spec_review_context/);
  assert.match(reviewer, /Any Waypost body with `Action: design_spec_review_context`/);
  assert.match(contextIntake, /missing, unsupported, or mismatched context/);
  assert.match(reviewer, /Before opening the target/);
  assert.match(contextIntake, /settle the claimed delivery under the shared Receiver Contract/);
  assert.match(reviewer, /author-authored task framing.*non-authoritative/);
  assert.match(reviewer, /require `Round <= Max Review Rounds`/);
  assert.match(reviewer, /Return NEEDS_INPUT without inspecting the target/);
  assert.match(reviewDelivery, /design_spec_review_context_rejected/);
  assert.match(reviewDelivery, /design_spec_review_context_recovery_requested/);
  assert.match(reviewDelivery, /Do not send NEEDS_INPUT or accept author-supplied replacement context/);
  assert.match(reviewDelivery, /marking the last `Recovery Complete: yes`/);
  assert.match(reviewDelivery, /actual inbound sender address/);
  assert.doesNotMatch(draftReview, /prepare-incremental-review\.mjs/);
  assert.match(draftReview, /Read an ordinary diff between the immutable prior and current artifacts/);
  assert.match(draftReview, /Reuse prior evidence from unchanged source/);
  assert.match(draftReview, /not another repository scan/);
  assert.match(messageRouter, /design_spec_review_context_recovery_requested/);
  assert.match(messageRouter, /Only the six discriminator aliases/);
  assert.match(
    read("skills/tech-design-workflow/references/context-recovery-route.md"),
    /Use the received recipient and `Relay` value/
  );
  assert.match(closeout, /--target architect-author=<author_session_id>/);
  assert.match(closeout, /--target architect-reviewer=<reviewer_session_id>/);
  assert.match(closeout, /--target architect=<reviewer_session_id>/);
  assert.match(requesterDelivery, /tech-design-workflow\/closeout/);
  assert.match(requesterDelivery, /archive and remove task sessions/);
  assert.match(reportHandling, /stable finding IDs/);
  assert.doesNotMatch(closeout, /generic workflow code does not remove them/);
});
