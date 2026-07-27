/** @description Tests for the opencode.json permission migration engine (issue #479, ac-1.1..ac-1.5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  RETIRED_OC_PERMISSION_ENTRIES,
  isValidOpencodeConfigShape,
  migrateOpencodeConfig,
  normalizeOcVersionStamp,
  readHarnessVersionStamp,
} from "./opencode-config-migration.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const NEW_CONFIG = {
  model: "openai/gpt-5.6-terra",
  permission: {
    question: "deny",
    glob: "allow",
    edit: { "*": "allow", ".env": "deny" },
    bash: {
      "*": "ask",
      "npx tsc --noEmit": "allow",
      'npx -y "github:orobsonn/claude-harness#v*" init --target both': "allow",
      "git pull": "allow",
    },
  },
};

test("ac-1.1: tier 1 (manifest present) replaces harness-owned keys with the new generation's set and leaves operator keys intact", () => {
  const manifest = {
    version: 1,
    harnessVersion: "v0.40.0",
    owned: {
      question: "allow", // harness used to write "allow" here; new generation wants "deny"
      glob: "allow",
      edit: { "*": "allow", ".env": "deny" },
      bash: { "*": "ask", "npx tsc --noEmit": "allow", "git pull": "allow" },
    },
  };
  const existingConfig = {
    model: "openai/gpt-5.6-terra",
    permission: {
      question: "allow", // untouched harness-owned default -> safe to replace
      glob: "allow",
      edit: { "*": "allow", ".env": "deny" },
      bash: { "*": "ask", "npx tsc --noEmit": "allow", "git pull": "allow", "docker *": "allow" }, // operator's own addition
    },
  };

  const result = migrateOpencodeConfig({ existingConfig, newConfig: NEW_CONFIG, manifest });

  assert.equal(result.tier, 1);
  assert.equal(result.config.permission.question, "deny", "harness-owned key must move to the new generation's value");
  assert.equal(
    result.config.permission.bash["docker *"],
    "allow",
    "operator's own bash rule (never owned by the manifest) must survive untouched",
  );
});

test("ac-1.1: a harness-owned key the operator diverged on is kept and not silently overwritten", () => {
  const manifest = {
    version: 1,
    harnessVersion: "v0.40.0",
    owned: { question: "allow" },
  };
  const existingConfig = { permission: { question: "ask" } }; // operator changed it away from the recorded owned value
  const result = migrateOpencodeConfig({ existingConfig, newConfig: { permission: { question: "deny" } }, manifest });

  assert.equal(result.config.permission.question, "ask", "operator's divergent value must survive");
  const kept = result.report.find((r) => r.path.join(".") === "question" && r.action === "kept-custom");
  assert.ok(kept, "divergence from the manifest must be reported");
});

test("ac-1.2: tier 2 (no manifest, legible .harness-version) prunes a retired key whose value still matches the ledger", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[0];
  const existingConfig = {
    permission: {
      bash: {
        "*": "ask",
        "npx tsc --noEmit": "allow",
        "git pull": "allow",
        [retired.path[1]]: retired.historicalValue, // unmodified legacy default
      },
    },
  };

  const result = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: "v0.14.0",
  });

  assert.equal(result.tier, 2);
  assert.ok(
    !Object.hasOwn(result.config.permission.bash, retired.path[1]),
    "a retired key with a value equal to its historical default must be removed",
  );
  const removed = result.report.find((r) => r.path.join(" ") === retired.path.join(" "));
  assert.equal(removed.action, "removed-retired");
});

test("ac-1.2: tier 2 keeps and reports a retired key whose value diverges from the ledger's historical default", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[3]; // ["bash", "git pull*"]
  const existingConfig = {
    permission: {
      bash: {
        "*": "ask",
        "npx tsc --noEmit": "allow",
        "git pull": "allow",
        [retired.path[1]]: "ask", // operator customized this away from the historical "allow"
      },
    },
  };

  const result = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: "v0.14.0",
  });

  assert.equal(result.tier, 2);
  assert.equal(
    result.config.permission.bash[retired.path[1]],
    "ask",
    "a retired key whose value diverges from history must be kept, not pruned",
  );
  const kept = result.report.find((r) => r.path.join(" ") === retired.path.join(" "));
  assert.equal(kept.action, "kept-custom");
});

test("ac-1.3: tier 3 (fresh project) receives the full new generation's set and gains a manifest", () => {
  const result = migrateOpencodeConfig({
    existingConfig: {},
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: null,
  });

  assert.equal(result.tier, 3);
  assert.deepEqual(result.config.permission, NEW_CONFIG.permission);
  assert.deepEqual(result.manifest.owned, NEW_CONFIG.permission, "the fresh manifest must own the entire set it just wrote");
});

test("ac-1.4: a second pass over the migration's own output is byte-identical (idempotent)", () => {
  const first = migrateOpencodeConfig({
    existingConfig: {},
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: null,
    newHarnessVersion: "v0.50.0",
  });

  const second = migrateOpencodeConfig({
    existingConfig: first.config,
    newConfig: NEW_CONFIG,
    manifest: first.manifest,
    previousHarnessVersionStamp: null,
    newHarnessVersion: "v0.50.0",
  });

  assert.equal(hash(second.config), hash(first.config));
  assert.equal(hash(second.manifest), hash(first.manifest));
  assert.deepEqual(second.report, [], "nothing should change on a converged second pass");
});

test("ac-1.4: idempotent even across tier 2 (ledger-pruned project re-migrated once more)", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[0];
  const existingConfig = {
    permission: { bash: { "*": "ask", "npx tsc --noEmit": "allow", "git pull": "allow", [retired.path[1]]: retired.historicalValue } },
  };
  const first = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: "v0.14.0",
    newHarnessVersion: "v0.50.0",
  });
  const second = migrateOpencodeConfig({
    existingConfig: first.config,
    newConfig: NEW_CONFIG,
    manifest: first.manifest,
    previousHarnessVersionStamp: null,
    newHarnessVersion: "v0.50.0",
  });

  assert.equal(hash(second.config), hash(first.config));
  assert.deepEqual(second.report, []);
});

test("ac-1.5: normalizes a bare SHA (pre-tagging baseline) to generation zero", () => {
  assert.deepEqual(normalizeOcVersionStamp("a1b2c3d"), { major: 0, minor: 0, patch: 0 });
});

test("ac-1.5: normalizes an exact vX.Y.Z tag", () => {
  assert.deepEqual(normalizeOcVersionStamp("v0.49.8"), { major: 0, minor: 49, patch: 8 });
});

test("ac-1.5: normalizes a git-describe stamp by stripping the -N-g<sha> distance suffix", () => {
  assert.deepEqual(normalizeOcVersionStamp("v0.49.8-12-gA1b2c3d"), { major: 0, minor: 49, patch: 8 });
});

test("ac-1.5: unparseable/empty stamps return null", () => {
  assert.equal(normalizeOcVersionStamp(""), null);
  assert.equal(normalizeOcVersionStamp(undefined), null);
});

test("readHarnessVersionStamp extracts the first non-empty line, or null when unreadable", () => {
  assert.equal(readHarnessVersionStamp("v0.49.8\nvendored_at: 2026-07-27\n"), "v0.49.8");
  assert.equal(readHarnessVersionStamp("\n\n"), null);
  assert.equal(readHarnessVersionStamp(null), null);
});

test("a type mismatch (operator's scalar vs. the new generation's object map) never silently discards the operator's value", () => {
  const existingConfig = { permission: { bash: "deny" } }; // operator's own blanket policy
  const newConfig = { permission: { bash: { "*": "ask", "git push*": "allow" } } };

  const result = migrateOpencodeConfig({ existingConfig, newConfig, manifest: null });

  assert.equal(result.config.permission.bash, "deny", "the operator's scalar must survive, not be coerced into {}");
  const kept = result.report.find((r) => r.path.join(".") === "bash" && r.action === "kept-custom");
  assert.ok(kept, "the divergence must be reported, not silently dropped");
});

test("a type-mismatched scalar that matches the manifest's owned value is safely upgraded to the new object shape", () => {
  const manifest = { version: 1, harnessVersion: "v0.40.0", owned: { bash: "allow" } };
  const existingConfig = { permission: { bash: "allow" } }; // unmodified harness-owned scalar default
  const newConfig = { permission: { bash: { "*": "ask" } } };

  const result = migrateOpencodeConfig({ existingConfig, newConfig, manifest });

  assert.deepEqual(result.config.permission.bash, { "*": "ask" });
});

test("isValidOpencodeConfigShape rejects a non-object config or a mis-shaped permission/plugin", () => {
  assert.equal(isValidOpencodeConfigShape({ permission: {}, plugin: [] }), true);
  assert.equal(isValidOpencodeConfigShape(null), false);
  assert.equal(isValidOpencodeConfigShape("not an object"), false);
  assert.equal(isValidOpencodeConfigShape({ permission: "not an object" }), false);
  assert.equal(isValidOpencodeConfigShape({ plugin: "not an array" }), false);
});

test("the generation gate stops a coincidental value match on a project newer than the ledger's shippedThroughGeneration", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[0]; // shippedThroughGeneration v0.45.0
  const existingConfig = {
    permission: { bash: { "*": "ask", "npx tsc --noEmit": "allow", "git pull": "allow", [retired.path[1]]: retired.historicalValue } },
  };

  const result = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: "v0.46.0", // newer than shippedThroughGeneration -> harness never shipped this key here
  });

  assert.equal(
    result.config.permission.bash[retired.path[1]],
    retired.historicalValue,
    "a project newer than the retirement cutoff must keep the key — it can only be the operator's own doing",
  );
  const kept = result.report.find((r) => r.path.join(" ") === retired.path.join(" "));
  assert.equal(kept.action, "kept-custom");
});

test("migrateOpencodeConfig never touches top-level config keys outside permission", () => {
  const existingConfig = { model: "custom/model", agent: { foo: "bar" }, permission: {} };
  const result = migrateOpencodeConfig({ existingConfig, newConfig: NEW_CONFIG, manifest: null });
  assert.equal(result.config.model, "custom/model");
  assert.deepEqual(result.config.agent, { foo: "bar" });
});
