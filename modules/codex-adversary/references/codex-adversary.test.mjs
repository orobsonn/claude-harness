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

test("checkAvailability: headless WITH API key may proceed if codex present", () => {
  const r = checkAvailability({ env: { CLAUDE_CODE_REMOTE: "1", OPENAI_API_KEY: "sk-x" }, hasCodex: () => true });
  assert.equal(r.ok, true);
});

test("checkAvailability: missing codex binary is unavailable", () => {
  const r = checkAvailability({ env: {}, hasCodex: () => false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/i);
});

test("checkAvailability: subscription login (loginStatus exit 0 'Logged in') and no OPENAI_API_KEY is available", () => {
  const r = checkAvailability({
    env: {},
    hasCodex: () => true,
    loginStatus: () => ({ status: 0, stdout: "Logged in using ChatGPT" }),
  });
  assert.equal(r.ok, true);
});

test("checkAvailability: definitively-not-authed probe (non-zero / 'not logged in') with no API key is unavailable", () => {
  const r = checkAvailability({
    env: {},
    hasCodex: () => true,
    loginStatus: () => ({ status: 1, stdout: "Not logged in" }),
  });
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
});

test("checkAvailability: ambiguous probe (throws / times out) with no API key is available so real codex exec is the authority", () => {
  const r = checkAvailability({
    env: {},
    hasCodex: () => true,
    loginStatus: () => {
      throw new Error("spawn ETIMEDOUT");
    },
  });
  assert.equal(r.ok, true);
});

test("checkAvailability: OPENAI_API_KEY is an accepted alternate credential even when loginStatus reports not-authed", () => {
  const r = checkAvailability({
    env: { OPENAI_API_KEY: "sk-x" },
    hasCodex: () => true,
    loginStatus: () => ({ status: 1, stdout: "Not logged in" }),
  });
  assert.equal(r.ok, true);
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
  assert.match(prompt, /=== ROLE \(verbatim from core\/agents\/adversary\.md\) ===/);
  assert.match(prompt, /=== SKILL 1 \(verbatim\) ===/);
  assert.match(prompt, /scope_paths/);
  assert.match(prompt, /issues\[\]/);
});

test("checkAvailability: spawnSync timeout return-shape (status null + error, not a throw) is ambiguous -> available", () => {
  const r = checkAvailability({
    env: {},
    hasCodex: () => true,
    loginStatus: () => ({ status: null, error: new Error("spawn ETIMEDOUT"), signal: "SIGTERM", stdout: "" }),
  });
  assert.equal(r.ok, true);
});
