/** @description Locked tests for the approved hand-model ladder (#361). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_HAND_LADDER,
  APPROVED_HAND_MODELS,
  DEFAULT_HAND_MODEL,
  formatApprovedLadder,
  isApprovedHandModel,
  resolveHandModel,
} from "./hand-model-ladder.mjs";

test("ladder: pins the three verified models as a genuine weak→strong escalation", () => {
  assert.deepEqual(APPROVED_HAND_LADDER, {
    low: "gemma4",
    medium: "glm-5.2",
    high: "kimi-k2.7-code",
  });
  // Three DIFFERENT models — a flattened ladder would silently defeat the escalation.
  assert.equal(new Set(Object.values(APPROVED_HAND_LADDER)).size, 3);
});

test("ladder: the default fallback is itself an approved model (never opens the door)", () => {
  assert.equal(DEFAULT_HAND_MODEL, "glm-5.2");
  assert.ok(APPROVED_HAND_MODELS.has(DEFAULT_HAND_MODEL));
});

test("isApprovedHandModel: membership over the 3, nothing else", () => {
  assert.equal(isApprovedHandModel("gemma4"), true);
  assert.equal(isApprovedHandModel("glm-5.2"), true);
  assert.equal(isApprovedHandModel("kimi-k2.7-code"), true);
  assert.equal(isApprovedHandModel("gpt-oss:120b"), false);
  // An id that EXISTS in the API but is outside the ladder — proves this is an allowlist,
  // not a pointed veto of gpt-oss (#ac-1.2).
  assert.equal(isApprovedHandModel("deepseek-v4-pro"), false);
  assert.equal(isApprovedHandModel("qwen3-coder:480b"), false);
  assert.equal(isApprovedHandModel(undefined), false);
  assert.equal(isApprovedHandModel(42), false);
});

test("resolveHandModel: an approved id resolves as-is with no fallback signal", () => {
  assert.deepEqual(resolveHandModel("gemma4"), { model: "gemma4", modelFallbackUsed: false });
  assert.deepEqual(resolveHandModel("kimi-k2.7-code"), {
    model: "kimi-k2.7-code",
    modelFallbackUsed: false,
  });
});

test("resolveHandModel: absence falls back to glm-5.2 and ALWAYS announces it (#ac-1.3/#ac-1.4)", () => {
  for (const absent of [undefined, null, ""]) {
    assert.deepEqual(resolveHandModel(absent), {
      model: "glm-5.2",
      modelFallbackUsed: true,
    });
  }
});

test("resolveHandModel: an out-of-ladder id is a HARD refusal, never laundered into the fallback", () => {
  for (const refused of ["gpt-oss:120b", "deepseek-v4-pro", "qwen3-coder:480b", "opus"]) {
    assert.throws(
      () => resolveHandModel(refused),
      (err) => {
        // The error must name the refused id AND the approved ladder — an operator reading it
        // must not need to open the source to learn what is allowed.
        assert.match(err.message, new RegExp(refused.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(err.message, /gemma4/);
        assert.match(err.message, /glm-5\.2/);
        assert.match(err.message, /kimi-k2\.7-code/);
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

test("formatApprovedLadder: renders every tier and model", () => {
  const rendered = formatApprovedLadder();
  for (const [tier, model] of Object.entries(APPROVED_HAND_LADDER)) {
    assert.match(rendered, new RegExp(tier));
    assert.match(rendered, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
