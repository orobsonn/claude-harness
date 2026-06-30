import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveCanonicalPath, ROLES } from "./codex-adversary.mjs";

// The module ships under TWO layouts and must resolve the canonical core sources in BOTH:
//   - source repo:  <root>/core/agents/adversary.md     (module at <root>/modules/...)
//   - vendored:     <root>/agents/adversary.md          (module at <root>/.claude/modules/...)
// resolveCanonicalPath tries `<repoRoot>/core/<rel>` first, then `<repoRoot>/<rel>`.

test("resolveCanonicalPath: source layout resolves under core/", () => {
  const p = resolveCanonicalPath("agents/adversary.md", {
    repoRoot: "/src",
    exists: (x) => x === "/src/core/agents/adversary.md",
  });
  assert.equal(p, "/src/core/agents/adversary.md");
});

test("resolveCanonicalPath: vendored layout resolves without core/", () => {
  const p = resolveCanonicalPath("agents/adversary.md", {
    repoRoot: "/proj/.claude",
    exists: (x) => x === "/proj/.claude/agents/adversary.md",
  });
  assert.equal(p, "/proj/.claude/agents/adversary.md");
});

test("resolveCanonicalPath: neither exists falls back to the core/ variant (clear error target)", () => {
  const p = resolveCanonicalPath("agents/adversary.md", { repoRoot: "/x", exists: () => false });
  assert.equal(p, "/x/core/agents/adversary.md");
});

test("ROLES role files resolve to a path that exists in THIS (source) repo", () => {
  for (const [name, cfg] of Object.entries(ROLES)) {
    assert.ok(existsSync(cfg.rolePath), `${name} rolePath should exist: ${cfg.rolePath}`);
  }
});
