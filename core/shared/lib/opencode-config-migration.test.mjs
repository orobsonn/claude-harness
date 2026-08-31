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

function resolvePatternMap(map, value) {
  const entries = Object.entries(map);
  for (let index = entries.length - 1; index >= 0; index--) {
    const [pattern, action] = entries[index];
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(value)) return action;
  }
  return undefined;
}

const NEW_CONFIG = {
  model: "openai/gpt-5.6-terra",
  permission: {
    question: "deny",
    glob: "allow",
    edit: { "*": "allow", ".env": "deny" },
    bash: {
      "*": "allow",
      "npx tsc --noEmit": "allow",
      'npx -y "github:orobsonn/claude-harness#v*" init --target both': "allow",
      "git pull": "allow",
    },
  },
};

const HARNESS_COMPACTION = {
  auto: true,
  prune: false,
  preserve_recent_tokens: 8000,
  reserved: 60000,
};

const HARNESS_TERRA_CONTEXT = {
  openai: {
    models: {
      "gpt-5.6-terra": {
        limit: { context: 200000, output: 32000 },
      },
    },
  },
};

test("compaction reaches a provenanced legacy project, updates only an owned value, and preserves explicit opt-outs", () => {
  const legacy = migrateOpencodeConfig({
    existingConfig: { model: "project/model", permission: {} },
    newConfig: { permission: {}, compaction: HARNESS_COMPACTION },
    previousHarnessVersionStamp: "v2.0.10",
    newHarnessVersion: "v2.0.12",
    isExistingProject: true,
  });
  assert.deepEqual(legacy.config.compaction, HARNESS_COMPACTION);
  assert.deepEqual(legacy.manifest.ownedTopLevel.compaction, HARNESS_COMPACTION);

  const upgradedPolicy = { ...HARNESS_COMPACTION, reserved: 70000 };
  const managed = migrateOpencodeConfig({
    existingConfig: legacy.config,
    newConfig: { permission: {}, compaction: upgradedPolicy },
    manifest: legacy.manifest,
    newHarnessVersion: "v2.0.13",
    isExistingProject: true,
  });
  assert.deepEqual(managed.config.compaction, upgradedPolicy, "an unchanged harness value must update");

  const custom = migrateOpencodeConfig({
    existingConfig: { ...legacy.config, compaction: false },
    newConfig: { permission: {}, compaction: upgradedPolicy },
    manifest: legacy.manifest,
    isExistingProject: true,
  });
  assert.equal(custom.config.compaction, false, "an explicit project opt-out must survive");
  assert.equal(custom.manifest.ownedTopLevel, undefined, "a diverged value must not remain harness-owned");

  const removed = migrateOpencodeConfig({
    existingConfig: { model: "project/model", permission: {} },
    newConfig: { permission: {}, compaction: upgradedPolicy },
    manifest: legacy.manifest,
    isExistingProject: true,
  });
  assert.equal(Object.hasOwn(removed.config, "compaction"), false, "removing a previously owned value is an opt-out");
  assert.equal(removed.manifest.ownedTopLevel, undefined);
});

test("compaction never appears in an unprovenanced existing project config", () => {
  const result = migrateOpencodeConfig({
    existingConfig: { model: "project/model", permission: {} },
    newConfig: { permission: {}, compaction: HARNESS_COMPACTION },
    isExistingProject: true,
  });
  assert.equal(Object.hasOwn(result.config, "compaction"), false);
  assert.equal(result.manifest.ownedTopLevel, undefined);
});

test("the harness context policy reaches only a provenanced config with no provider override", () => {
  const legacy = migrateOpencodeConfig({
    existingConfig: {
      model: "openai/gpt-5.6-terra",
      permission: {},
      provider: { openai: { options: { baseURL: "https://operator.example/v1" }, models: { "operator-model": { name: "keep" } } }, anthropic: { whitelist: ["claude"] } },
    },
    newConfig: { permission: {}, provider: HARNESS_TERRA_CONTEXT },
    previousHarnessVersionStamp: "v2.0.12",
    newHarnessVersion: "v2.0.13",
    isExistingProject: true,
  });
  assert.equal(legacy.config.provider.openai.options.baseURL, "https://operator.example/v1");
  assert.equal(legacy.config.provider.openai.models["operator-model"].name, "keep");
  assert.deepEqual(legacy.config.provider.openai.models["gpt-5.6-terra"].limit, { context: 200000, output: 32000 });
  assert.deepEqual(legacy.config.provider.anthropic, { whitelist: ["claude"] });
  assert.deepEqual(legacy.manifest.ownedTopLevel.providerOpenAiTerraLimit, { context: 200000, output: 32000 });

  const custom = migrateOpencodeConfig({
    existingConfig: {
      model: "openai/gpt-5.6-terra",
      permission: {},
      provider: { openai: { models: { "gpt-5.6-terra": { limit: { context: 999999, output: 32000 } } } } },
    },
    newConfig: { permission: {}, provider: HARNESS_TERRA_CONTEXT },
    previousHarnessVersionStamp: "v2.0.12",
    isExistingProject: true,
  });
  assert.equal(custom.config.provider.openai.models["gpt-5.6-terra"].limit.context, 999999);
  assert.equal(custom.manifest.ownedTopLevel, undefined);

  const unmanaged = migrateOpencodeConfig({
    existingConfig: { model: "openai/gpt-5.6-terra", permission: {} },
    newConfig: { permission: {}, provider: HARNESS_TERRA_CONTEXT },
    isExistingProject: true,
  });
  assert.equal(Object.hasOwn(unmanaged.config, "provider"), false);
});

const RETIRED_MARK_GATE_PERMISSIONS = [
  "node .opencode/plugin/lib/mark-gate.mjs *",
  "node core/opencode/plugin/lib/mark-gate.mjs *",
];

test("mark-gate retirement removes only historical harness-owned allows and converges", () => {
  for (const permission of RETIRED_MARK_GATE_PERMISSIONS) {
    const ledger = RETIRED_OC_PERMISSION_ENTRIES.find(
      (entry) => entry.path[0] === "bash" && entry.path[1] === permission,
    );
    assert.deepEqual(ledger, { path: ["bash", permission], historicalValue: "allow" });
  }

  const sibling = "node .opencode/plugin/lib/project-owned.mjs *";
  const existingConfig = {
    permission: {
      bash: {
        [RETIRED_MARK_GATE_PERMISSIONS[0]]: "allow",
        [RETIRED_MARK_GATE_PERMISSIONS[1]]: "allow",
        [sibling]: "allow",
      },
    },
  };
  const migrated = migrateOpencodeConfig({
    existingConfig,
    newConfig: { permission: { bash: {} } },
    previousHarnessVersionStamp: "v0.56.0",
    newHarnessVersion: "v0.57.0",
  });
  for (const permission of RETIRED_MARK_GATE_PERMISSIONS) {
    assert.equal(Object.hasOwn(migrated.config.permission.bash, permission), false);
  }
  assert.equal(migrated.config.permission.bash[sibling], "allow");

  const repeated = migrateOpencodeConfig({
    existingConfig: migrated.config,
    newConfig: { permission: { bash: {} } },
    manifest: migrated.manifest,
    newHarnessVersion: "v0.57.0",
  });
  assert.deepEqual(repeated.config, migrated.config);
  assert.equal(repeated.report.some((entry) => entry.action === "removed-retired" || entry.action === "updated"), false);

  const customized = migrateOpencodeConfig({
    existingConfig: {
      permission: {
        bash: {
          [RETIRED_MARK_GATE_PERMISSIONS[1]]: "ask",
          [sibling]: "allow",
        },
      },
    },
    newConfig: { permission: { bash: {} } },
    previousHarnessVersionStamp: "v0.56.0",
  });
  assert.equal(customized.config.permission.bash[RETIRED_MARK_GATE_PERMISSIONS[1]], "ask");
  assert.equal(customized.config.permission.bash[sibling], "allow");

  const unprovenanced = migrateOpencodeConfig({
    existingConfig: {
      permission: { bash: { [RETIRED_MARK_GATE_PERMISSIONS[0]]: "allow" } },
    },
    newConfig: { permission: { bash: {} } },
  });
  assert.equal(unprovenanced.config.permission.bash[RETIRED_MARK_GATE_PERMISSIONS[0]], "allow");
});

test("ac-1.1: tier 1 replaces the old harness-owned ask wildcard with Auto Mode allow and leaves operator keys intact", () => {
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
  assert.equal(result.config.permission.bash["*"], "allow", "harness-owned ask must migrate to Auto Mode allow");
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
  const retired = RETIRED_OC_PERMISSION_ENTRIES[0]; // ["bash", "npx github:orobsonn/claude-harness#* init*"]
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

test("historical edit/read scalar allows upgrade to protected maps across the provenanced fleet", () => {
  const editLedger = RETIRED_OC_PERMISSION_ENTRIES.find((entry) => entry.path.join(".") === "edit");
  const readLedger = RETIRED_OC_PERMISSION_ENTRIES.find((entry) => entry.path.join(".") === "read");
  assert.deepEqual(editLedger, { path: ["edit"], historicalValue: "allow" });
  assert.deepEqual(readLedger, { path: ["read"], historicalValue: "allow" });

  const newConfig = {
    permission: {
      edit: { "*": "allow", ".opencode/plans/.state/**": "deny" },
      read: { "*": "allow", ".env": "deny" },
    },
  };
  const first = migrateOpencodeConfig({
    existingConfig: { permission: { edit: "allow", read: "allow" } },
    newConfig,
    manifest: { version: 1, harnessVersion: "v0.56.0", owned: {} },
    newHarnessVersion: "v0.57.0",
  });

  assert.deepEqual(first.config.permission.edit, newConfig.permission.edit);
  assert.deepEqual(first.config.permission.read, newConfig.permission.read);
  assert.equal(
    resolvePatternMap(first.config.permission.edit, ".opencode/plans/.state/session/gate-state.json"),
    "deny",
  );
  assert.equal(resolvePatternMap(first.config.permission.read, ".env"), "deny");
  assert.ok(first.report.some((entry) => entry.path.join(".") === "edit" && entry.action === "updated"));
  assert.ok(first.report.some((entry) => entry.path.join(".") === "read" && entry.action === "updated"));

  const repeated = migrateOpencodeConfig({
    existingConfig: first.config,
    newConfig,
    manifest: first.manifest,
    newHarnessVersion: "v0.57.0",
  });
  assert.deepEqual(repeated.config, first.config);
  assert.deepEqual(repeated.report, []);

  const stampOnly = migrateOpencodeConfig({
    existingConfig: { permission: { edit: "allow", read: "allow" } },
    newConfig,
    previousHarnessVersionStamp: "v0.40.0",
    newHarnessVersion: "v0.57.0",
  });
  assert.equal(stampOnly.tier, 2);
  assert.equal(
    resolvePatternMap(stampOnly.config.permission.edit, ".opencode/plans/.state/session/gate-state.json"),
    "deny",
  );
  assert.equal(resolvePatternMap(stampOnly.config.permission.read, ".env"), "deny");
});

test("scalar map upgrade requires both harness provenance and the exact historical allow", () => {
  const newConfig = {
    permission: {
      edit: { "*": "allow", ".opencode/plans/.state/**": "deny" },
      read: { "*": "allow", ".env": "deny" },
    },
  };

  const operatorDiverged = migrateOpencodeConfig({
    existingConfig: { permission: { edit: "deny", read: "ask" } },
    newConfig,
    previousHarnessVersionStamp: "v0.56.0",
  });
  assert.equal(operatorDiverged.config.permission.edit, "deny");
  assert.equal(operatorDiverged.config.permission.read, "ask");

  const neverVendored = migrateOpencodeConfig({
    existingConfig: { permission: { edit: "allow", read: "allow" } },
    newConfig,
  });
  assert.equal(neverVendored.config.permission.edit, "allow");
  assert.equal(neverVendored.config.permission.read, "allow");
});

test("isValidOpencodeConfigShape rejects a non-object config or a mis-shaped permission/plugin", () => {
  assert.equal(isValidOpencodeConfigShape({ permission: {}, plugin: [] }), true);
  assert.equal(isValidOpencodeConfigShape(null), false);
  assert.equal(isValidOpencodeConfigShape("not an object"), false);
  assert.equal(isValidOpencodeConfigShape({ permission: "not an object" }), false);
  assert.equal(isValidOpencodeConfigShape({ plugin: "not an array" }), false);
});

test("issue #513 ac-1: a retired key with a matching value is removed EVEN when the project's version stamp is newer than the entry was last shipped — retirement is by content, not by generation cutoff", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[0];
  const existingConfig = {
    permission: { bash: { "*": "ask", "npx tsc --noEmit": "allow", "git pull": "allow", [retired.path[1]]: retired.historicalValue } },
  };

  const result = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    // Re-vendored well after the entry's historical last-shipped generation (a project seeded
    // before the retirement and re-vendored after it, while the migration engine itself didn't
    // exist yet — #503 — is exactly the real-population case #513 reports).
    previousHarnessVersionStamp: "v0.49.1",
  });

  assert.ok(
    !Object.hasOwn(result.config.permission.bash, retired.path[1]),
    "a retired key must be removed by content match alone, regardless of the project's own generation stamp",
  );
  const removed = result.report.find((r) => r.path.join(" ") === retired.path.join(" "));
  assert.equal(removed.action, "removed-retired");
});

test("issue #513 ac-1: a project with ZERO harness provenance (no manifest, no version stamp) keeps a coincidentally matching value untouched", () => {
  const retired = RETIRED_OC_PERMISSION_ENTRIES[RETIRED_OC_PERMISSION_ENTRIES.length - 1]; // ["bash", "*"]
  const existingConfig = {
    permission: { bash: { "*": retired.historicalValue, "npx tsc --noEmit": "allow", "git pull": "allow" } },
  };

  const result = migrateOpencodeConfig({
    existingConfig,
    newConfig: NEW_CONFIG,
    manifest: null,
    previousHarnessVersionStamp: null, // never vendored by the harness before
  });

  assert.equal(
    result.config.permission.bash["*"],
    retired.historicalValue,
    "with no proof the harness ever touched this project, a coincidental match can only be the operator's own doing",
  );
  const kept = result.report.find((r) => r.path.join(" ") === "bash *");
  assert.equal(kept.action, "kept-custom");
});

test("Auto Mode migration upgrades the historical harness ask wildcard in a provenanced tier-2 project", () => {
  const wildcard = RETIRED_OC_PERMISSION_ENTRIES.find(
    (entry) => entry.path[0] === "bash" && entry.path[1] === "*",
  );
  assert.deepEqual(wildcard, { path: ["bash", "*"], historicalValue: "ask", tier2Only: true });
  const result = migrateOpencodeConfig({
    existingConfig: { permission: { bash: { "*": "ask", "docker *": "deny" } } },
    newConfig: NEW_CONFIG,
    previousHarnessVersionStamp: "v0.56.0",
    newHarnessVersion: "v0.57.0",
  });
  assert.equal(result.config.permission.bash["*"], "allow");
  assert.equal(result.config.permission.bash["docker *"], "deny");
});

test("Auto Mode migration preserves a tier-1 ask wildcard that its manifest proves was never harness-owned", () => {
  const result = migrateOpencodeConfig({
    existingConfig: { permission: { bash: { "*": "ask", "docker *": "deny" } } },
    newConfig: NEW_CONFIG,
    manifest: { version: 1, harnessVersion: "v0.56.0", owned: { bash: {} } },
    newHarnessVersion: "v0.57.0",
  });
  assert.equal(result.config.permission.bash["*"], "ask");
  assert.equal(result.config.permission.bash["docker *"], "deny");
  assert.ok(result.report.some((entry) => entry.path.join(".") === "bash.*" && entry.action === "kept-custom"));
});

test("custom broad allows stay present but cannot shadow the canonical safety suffix", () => {
  const newConfig = {
    permission: {
      edit: { "*": "allow", ".opencode/plans/.state/**": "deny" },
      bash: {
        "*": "allow",
        "node*.opencode/plans/.state/*": "deny",
        "rm -r*": "deny",
        "git push --force-with-lease*": "allow",
      },
    },
  };
  const result = migrateOpencodeConfig({
    existingConfig: {
      permission: {
        edit: { "*": "allow", ".opencode/**": "allow" },
        bash: { "*": "ask", "node *": "allow", "rm *": "allow" },
      },
    },
    newConfig,
    manifest: {
      version: 1,
      harnessVersion: "v0.56.0",
      owned: { edit: { "*": "allow" }, bash: { "*": "ask" } },
    },
  });
  assert.equal(result.config.permission.edit[".opencode/**"], "allow", "custom key remains present");
  assert.equal(result.config.permission.bash["node *"], "allow", "custom node key remains present");
  assert.equal(result.config.permission.bash["rm *"], "allow", "custom rm key remains present");
  assert.equal(resolvePatternMap(result.config.permission.edit, ".opencode/plans/.state/s/gate-state.json"), "deny");
  assert.equal(resolvePatternMap(result.config.permission.bash, `node -e 'write(".opencode/plans/.state/s/gate-state.json")'`), "deny");
  assert.equal(resolvePatternMap(result.config.permission.bash, "rm -rf ./build"), "deny");
});

test("migrateOpencodeConfig never touches top-level config keys outside permission", () => {
  const existingConfig = { model: "custom/model", agent: { foo: "bar" }, permission: {} };
  const result = migrateOpencodeConfig({ existingConfig, newConfig: NEW_CONFIG, manifest: null });
  assert.equal(result.config.model, "custom/model");
  assert.deepEqual(result.config.agent, { foo: "bar" });
});
