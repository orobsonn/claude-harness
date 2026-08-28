/** @description Locked tests for the approved hand ladders (#361) and the family toggle. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HAND_LADDERS,
  HAND_FAMILIES,
  HAND_EFFORT_BY_TIER,
  HAND_TOKEN_ENV_KEYS,
  APPROVED_HAND_MODELS,
  DEFAULT_HAND_FAMILY,
  defaultHandModelFor,
  detectHandFamily,
  familyOfHandModel,
  formatApprovedLadder,
  formatAllApprovedLadders,
  isApprovedHandModel,
  ladderFor,
  readActiveHandFamily,
  resolveHandEffort,
  resolveHandModel,
  transportFor,
  writeActiveHandFamily,
} from "./hand-model-ladder.mjs";

/** @description A throwaway project root; every disk test runs inside its own. */
function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hand-family-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ladders: ollama pins the three verified models as a genuine weak→strong escalation", () => {
  assert.deepEqual(HAND_LADDERS.ollama, {
    low: "gemma4",
    medium: "glm-5.2",
    high: "kimi-k2.7-code",
  });
});

test("ladders: claude escalates by EFFORT on its top rung, not by a different model id", () => {
  assert.deepEqual(HAND_LADDERS.claude, { low: "haiku", medium: "sonnet", high: "sonnet" });
  assert.equal(HAND_EFFORT_BY_TIER.claude.high, "xhigh");
  assert.equal(HAND_EFFORT_BY_TIER.claude.medium, undefined);
});

test("ladders: every family is three DISTINCT rungs as (model, effort) pairs", () => {
  // A flattened ladder would silently defeat the escalation — and for the claude family the model
  // id ALONE is flat, which is exactly why the rung, not the id, is the unit of uniqueness.
  for (const family of HAND_FAMILIES) {
    const rungs = Object.entries(ladderFor(family)).map(
      ([tier, model]) => `${model}@${resolveHandEffort(model, tier) ?? "default"}`,
    );
    assert.equal(new Set(rungs).size, 3, `${family} must have 3 distinct rungs, got ${rungs.join(", ")}`);
  }
});

test("ladders: the two families share no model id (an id alone identifies its transport)", () => {
  const ollama = new Set(Object.values(HAND_LADDERS.ollama));
  for (const model of Object.values(HAND_LADDERS.claude)) {
    assert.equal(ollama.has(model), false, `${model} must belong to exactly one family`);
  }
});

test("defaultHandModelFor: each family's fallback is itself an approved model of that family", () => {
  for (const family of HAND_FAMILIES) {
    const model = defaultHandModelFor(family);
    assert.ok(APPROVED_HAND_MODELS.has(model));
    assert.equal(familyOfHandModel(model), family);
  }
  assert.equal(defaultHandModelFor(), defaultHandModelFor(DEFAULT_HAND_FAMILY));
});

test("isApprovedHandModel: membership over BOTH ladders, nothing else", () => {
  for (const model of ["gemma4", "glm-5.2", "kimi-k2.7-code", "haiku", "sonnet"]) {
    assert.equal(isApprovedHandModel(model), true, model);
  }
  // opus is the tell of the legacy Claude `tiers` shape — an eye tier, never a hand rung.
  assert.equal(isApprovedHandModel("opus"), false);
  assert.equal(isApprovedHandModel("gpt-oss:120b"), false);
  // An id that EXISTS in the API but is outside the ladder — proves this is an allowlist,
  // not a pointed veto of gpt-oss (#ac-1.2).
  assert.equal(isApprovedHandModel("deepseek-v4-pro"), false);
  assert.equal(isApprovedHandModel(undefined), false);
  assert.equal(isApprovedHandModel(42), false);
});

test("resolveHandModel: an approved id resolves as-is with no fallback signal", () => {
  assert.deepEqual(resolveHandModel("gemma4"), { model: "gemma4", modelFallbackUsed: false });
  assert.deepEqual(resolveHandModel("haiku"), { model: "haiku", modelFallbackUsed: false });
});

test("resolveHandModel: absence falls back INSIDE the declared family and ALWAYS announces it", () => {
  for (const absent of [undefined, null, ""]) {
    assert.deepEqual(resolveHandModel(absent, { family: "ollama" }), {
      model: "glm-5.2",
      modelFallbackUsed: true,
    });
    // The fallback never crosses transports: a claude-family plan missing a rung falls back to a
    // claude rung, never to an Ollama id that would need a token the project may not even have.
    assert.deepEqual(resolveHandModel(absent, { family: "claude" }), {
      model: "sonnet",
      modelFallbackUsed: true,
    });
  }
});

test("resolveHandModel: an out-of-ladder id is a HARD refusal, never laundered into the fallback", () => {
  for (const refused of ["gpt-oss:120b", "deepseek-v4-pro", "qwen3-coder:480b", "opus"]) {
    assert.throws(
      () => resolveHandModel(refused),
      (err) => {
        // The error must name the refused id AND both ladders — an operator reading it must not
        // need to open the source to learn what is allowed.
        assert.match(err.message, new RegExp(refused.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(err.message, /gemma4/);
        assert.match(err.message, /haiku/);
        return true;
      },
      `expected ${refused} to be refused`,
    );
  }
});

test("resolveHandModel: the error names where the id came from", () => {
  assert.throws(
    () => resolveHandModel("gpt-oss:120b", { source: "plan tier medium" }),
    /plan tier medium/,
  );
});

test("resolveHandEffort: only the claude high rung carries an effort", () => {
  assert.equal(resolveHandEffort("sonnet", "high"), "xhigh");
  assert.equal(resolveHandEffort("sonnet", "medium"), undefined);
  assert.equal(resolveHandEffort("haiku", "low"), undefined);
  // The ollama endpoint has no effort control — never emit a flag it would choke on.
  assert.equal(resolveHandEffort("kimi-k2.7-code", "high"), undefined);
  assert.equal(resolveHandEffort("sonnet", null), undefined);
  assert.equal(resolveHandEffort("not-a-model", "high"), undefined);
});

test("detectHandFamily: derives the plan's family from its ids, and refuses a MIXED ladder", () => {
  assert.equal(detectHandFamily(HAND_LADDERS.ollama), "ollama");
  assert.equal(detectHandFamily(HAND_LADDERS.claude), "claude");
  // Mixed → null: guessing one would pick a transport the plan never declared.
  assert.equal(detectHandFamily({ low: "gemma4", medium: "sonnet", high: "sonnet" }), null);
  assert.equal(detectHandFamily({ low: "who-knows" }), null);
  assert.equal(detectHandFamily(undefined), null);
  assert.equal(detectHandFamily([]), null);
});

test("transportFor: the model id alone decides endpoint and token key — no config read", () => {
  const ollama = transportFor("glm-5.2");
  assert.equal(ollama.family, "ollama");
  assert.equal(ollama.baseUrl, "https://ollama.com");
  assert.equal(ollama.envKey, "OLLAMA_HAND_TOKEN");
  assert.equal(ollama.childEnvKey, "ANTHROPIC_AUTH_TOKEN");

  const claude = transportFor("sonnet");
  assert.equal(claude.family, "claude");
  // No base-url override: a claude hand talks to the Anthropic API, not to a third-party endpoint.
  assert.equal(claude.baseUrl, null);
  assert.equal(claude.envKey, "CLAUDE_HAND_TOKEN");
  assert.equal(claude.childEnvKey, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.match(claude.setup, /setup-token/);

  assert.throws(() => transportFor("opus"), /no approved transport/);
});

test("transportFor: BOTH families need a token — the fail-closed guard stays un-bypassable", () => {
  // Authenticating a claude hand by inheriting the operator's own Claude Code config would also
  // inherit its permission allowlist and additionalDirectories (measured: such a child runs Bash
  // and writes outside the repo). A token per family keeps the isolation AND the guard.
  for (const family of HAND_FAMILIES) {
    const transport = transportFor(defaultHandModelFor(family));
    assert.ok(transport.envKey.length > 0);
    assert.ok(HAND_TOKEN_ENV_KEYS.includes(transport.envKey));
  }
  assert.equal(HAND_TOKEN_ENV_KEYS.length, HAND_FAMILIES.length);
});

test("formatApprovedLadder: renders every tier and model of the named family", () => {
  for (const family of HAND_FAMILIES) {
    const rendered = formatApprovedLadder(family);
    for (const [tier, model] of Object.entries(ladderFor(family))) {
      assert.match(rendered, new RegExp(tier));
      assert.match(rendered, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
  assert.match(formatAllApprovedLadders(), /ollama →.*\| claude →/);
});

test("ladderFor: an unknown family is a throw, never a silent default", () => {
  assert.throws(() => ladderFor("olama"), /unknown hand family/);
  assert.throws(() => ladderFor(undefined), /unknown hand family/);
});

// --- the operator toggle ---

test("readActiveHandFamily: no config → the claude default, and it SAYS it defaulted", () => {
  withTempCwd((cwd) => {
    const active = readActiveHandFamily(cwd);
    assert.equal(active.family, "claude");
    assert.equal(active.source, "default");
  });
});

test("readActiveHandFamily: a written choice round-trips and reports source=config", () => {
  withTempCwd((cwd) => {
    const written = writeActiveHandFamily("ollama", cwd);
    assert.match(written.path, /\.claude\/hand-config\/hands\.json$/);
    assert.deepEqual(readActiveHandFamily(cwd), { family: "ollama", source: "config", path: written.path });
    writeActiveHandFamily("claude", cwd);
    assert.equal(readActiveHandFamily(cwd).family, "claude");
  });
});

test("readActiveHandFamily: a present-but-invalid config THROWS — never a silent default", () => {
  // A typo'd family that quietly fell back to the default would author a plan against the other
  // ladder while the operator believes they switched.
  for (const bad of ['{"family":"olama"}', '{"family":null}', "{not json", "[]"]) {
    withTempCwd((cwd) => {
      mkdirSync(join(cwd, ".claude", "hand-config"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "hand-config", "hands.json"), bad, "utf8");
      assert.throws(() => readActiveHandFamily(cwd), /hands\.json/, `expected ${bad} to throw`);
    });
  }
});

test("writeActiveHandFamily: an unknown family never reaches disk", () => {
  withTempCwd((cwd) => {
    assert.throws(() => writeActiveHandFamily("gpt", cwd), /unknown hand family/);
    assert.equal(readActiveHandFamily(cwd).source, "default", "nothing may have been written");
  });
});
