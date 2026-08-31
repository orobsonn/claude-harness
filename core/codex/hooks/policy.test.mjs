import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateHook, protectablePath } from "./policy.mjs";

const preBash = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

test("pre-tool hook denies force push before Bash runs", () => {
  const out = evaluateHook(preBash("git push --force origin main"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /force push/i);
});

test("pre-tool hook allows force-with-lease rather than forbidding all recovery", () => {
  assert.deepEqual(evaluateHook(preBash("git push --force-with-lease origin feature")), {});
});

test("pre-tool hook denies destructive cleanup and deploy commands", () => {
  for (const command of [
    "git reset --hard HEAD",
    "git clean -f",
    "git push origin main --force",
    "git -C repo push origin main -f",
    "cd repo && git reset --hard",
    "wrangler deploy",
    "env wrangler deploy",
    "command wrangler deploy",
    "/usr/bin/env wrangler deploy",
    "npx wrangler versions list",
    "npx --yes wrangler deploy",
    "npx -y wrangler secret put TOKEN",
    "pnpm exec wrangler secret put TOKEN",
    "pnpm dlx wrangler versions upload",
    "pnpm --silent dlx wrangler versions upload",
    "yarn dlx wrangler r2 bucket create data",
    "bunx wrangler d1 execute db --remote",
    "bun x wrangler r2 bucket create data",
    "npm exec -- wrangler d1 execute db --remote",
    "./node_modules/.bin/wrangler deploy",
    "npm run deploy",
    "yarn deploy",
  ]) {
    assert.equal(evaluateHook(preBash(command)).hookSpecificOutput.permissionDecision, "deny", command);
  }
});

test("pre-tool hook prevents shell reads of secret-bearing paths", () => {
  for (const command of [
    "cat .env",
    "rg token .dev.vars",
    "cat ~/.ssh/id_ed25519",
    "find ~/.aws -type f",
    "cat .env$(printf '')",
    "cat $(printf .env)",
    "cat .e??",
    "cat .{en}v",
    "cat .e[n]v",
    "cat ${SECRET_ENV_PATH}",
  ]) {
    assert.equal(evaluateHook(preBash(command)).hookSpecificOutput.permissionDecision, "deny", command);
  }
  assert.deepEqual(evaluateHook(preBash("cat package.json")), {});
});

test("pre-tool hook denies the two unsafe lavish CLI subcommands without blocking other use", () => {
  for (const command of [
    "npx lavish-axi share mockup",
    "lavish-axi@1.2.3 setup hooks",
    "echo ok && lavish-axi share landing",
  ]) {
    assert.equal(evaluateHook(preBash(command)).hookSpecificOutput.permissionDecision, "deny", command);
  }
  assert.deepEqual(evaluateHook(preBash("npx lavish-axi preview mockup")), {});
});

test("apply_patch cannot mutate harness-owned paths", () => {
  const out = evaluateHook({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Update File: .codex/hooks.json" },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(protectablePath(".codex/hooks.json"));
});

test("reading harness configuration stays available while shell mutations are denied", () => {
  assert.deepEqual(evaluateHook(preBash("cat .codex/hooks.json")), {});
  assert.equal(
    evaluateHook(preBash("printf '{}' > .codex/hooks.json")).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("post-tool payload does not claim a receipt when audit is unavailable", () => {
  const out = evaluateHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { exit_code: 0 },
  }, { auditDir: null });
  assert.deepEqual(out, {});
});

test("post-tool audit writes one validated immutable receipt without command contents", () => {
  const auditDir = mkdtempSync(join(tmpdir(), "codex-hook-audit-"));
  const output = evaluateHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    session_id: "ses_123",
    tool_use_id: "call_456",
    tool_input: { command: "secret-looking-command --token example" },
  }, { auditDir });
  assert.deepEqual(output, {});
  const files = readdirSync(auditDir);
  assert.equal(files.length, 1);
  const receipt = JSON.parse(readFileSync(join(auditDir, files[0]), "utf8"));
  assert.deepEqual(receipt, { event: "PostToolUse", tool: "Bash", session_id: "ses_123", tool_use_id: "call_456" });
});

test("malformed payload is denied conservatively before a tool call", () => {
  const out = evaluateHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});
