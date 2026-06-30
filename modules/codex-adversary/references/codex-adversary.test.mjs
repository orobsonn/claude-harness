import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripFrontmatter,
  parseJsonBlock,
  isHeadless,
  checkAvailability,
  runCodexAdversary,
  composeAdversaryPrompt,
} from "./codex-adversary.mjs";

test("stripFrontmatter removes a leading YAML block", () => {
  const md = "---\nname: adversary\nmodel: opus\n---\n\n# Body\ntext";
  assert.equal(stripFrontmatter(md).trim(), "# Body\ntext");
});

test("stripFrontmatter is a no-op without frontmatter", () => {
  assert.equal(stripFrontmatter("# Body").trim(), "# Body");
});

test("parseJsonBlock extracts a fenced json block amid prose", () => {
  const out = "thinking...\n```json\n{\"issues\":[{\"scope\":\"a.ts\"}]}\n```\ndone";
  assert.deepEqual(parseJsonBlock(out), { issues: [{ scope: "a.ts" }] });
});

test("parseJsonBlock falls back to a bare object", () => {
  assert.deepEqual(parseJsonBlock('noise {"issues":[]} tail'), { issues: [] });
});

test("isHeadless detects the cloud-routine env", () => {
  assert.equal(isHeadless({ CLAUDE_CODE_REMOTE: "1" }), true);
  assert.equal(isHeadless({}), false);
});

test("checkAvailability: headless without API key is unavailable by design", () => {
  const r = checkAvailability({ env: { CLAUDE_CODE_REMOTE: "1" }, hasCodex: () => true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /headless/i);
});

test("checkAvailability: headless WITH API key may proceed if codex present", () => {
  const r = checkAvailability({ env: { CLAUDE_CODE_REMOTE: "1", OPENAI_API_KEY: "sk-x" }, hasCodex: () => true });
  assert.equal(r.ok, true);
});

test("checkAvailability: missing codex binary is unavailable", () => {
  const r = checkAvailability({ env: {}, hasCodex: () => false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/i);
});

test("runCodexAdversary fails open when unavailable (never throws)", () => {
  const res = runCodexAdversary({ prompt: "x", availability: { ok: false, reason: "no codex" } });
  assert.equal(res.available, false);
  assert.deepEqual(res.issues, []);
});

test("runCodexAdversary parses issues from an injected fake spawn", () => {
  const fakeSpawn = (bin, args) => {
    assert.equal(bin, "codex");
    assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
    return { status: 0, stdout: "```json\n{\"issues\":[{\"scope\":\"a.ts\",\"severity\":\"high\"}]}\n```" };
  };
  const res = runCodexAdversary({ prompt: "p", spawn: fakeSpawn, availability: { ok: true, reason: "" } });
  assert.equal(res.available, true);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].scope, "a.ts");
});

test("runCodexAdversary fails open on non-zero exit", () => {
  const fakeSpawn = () => ({ status: 1, stderr: "boom" });
  const res = runCodexAdversary({ prompt: "p", spawn: fakeSpawn, availability: { ok: true, reason: "" } });
  assert.equal(res.available, false);
  assert.match(res.reason, /failed/i);
});

test("composeAdversaryPrompt embeds the canonical role + taxonomy from disk", () => {
  // Uses the REAL core sources — proves parity wiring resolves.
  const prompt = composeAdversaryPrompt({ taskJson: { scope_paths: ["src/x.ts"] } });
  assert.match(prompt, /ATTACK ROLE/);
  assert.match(prompt, /ATTACK TAXONOMY/);
  assert.match(prompt, /scope_paths/);
  assert.match(prompt, /issues\[\]/);
});
