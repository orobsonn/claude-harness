/**
 * @description Pins the hardened contract for `seedOpencodeRootConfig` (task-N, opencode headless
 * hardening). The function existing at authoring time returns `{ copied, wroteExample }` and simply
 * copies whatever `projectRoot/opencode.json` (or, as fallback, a vendored `opencode.json.example`
 * candidate) already contains. This suite fixes a STRONGER contract: the seeded worktree
 * `opencode.json` must always carry a safe, key-enforced `permission` block — `question: 'deny'`,
 * `external_directory: 'allow'`, `bash['*']: 'allow'` plus the dangerous-command deny-list — even
 * when the source config is stale, incomplete, malformed, or entirely absent (double-fault). These
 * assertions describe the CONTRACT the hardened implementation must satisfy; they are authored
 * against the CURRENT (pre-hardening) function and are expected to fail until that hardening lands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  seedOpencodeRootConfig,
  ocPluginFilesExist,
  rewriteOcPluginsToMonorepoCore,
  ensureOcPluginPathsExist,
} from "./cron-a-dispatch.mjs";


const CANONICAL_STUBS = [
  "entry-gate.ts",
  "plan-gate.ts",
  "plan-write-gate.ts",
  "loop-guard.ts",
  "reinject-state.ts",
  "version-check.ts",
  "harvest-guard.ts",
  "obs-plan-write.ts",
  "obs-eye.ts",
  "obs-hand.ts",
  "agent-idle-nudge.ts",
];

/** @description Write stub plugin files under root/core/opencode/plugin. */
function writeMonorepoPluginStubs(root) {
  const corePlugin = join(root, "core", "opencode", "plugin");
  mkdirSync(corePlugin, { recursive: true });
  for (const name of CANONICAL_STUBS) {
    writeFileSync(join(corePlugin, name), `// stub ${name}\n`, "utf8");
  }
}

/** @description Fresh temp root with projectRoot + worktree dirs. */
function makeSeedDirs(prefix, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectRoot = join(root, "proj");
  const worktree = join(root, "wt");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  if (!opts.bare) {
    writeMonorepoPluginStubs(worktree);
  }
  return { root, projectRoot, worktree };
}

test("seedOpencodeRootConfig: forces permission.question to 'deny' even when the projectRoot source omits it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-question-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { external_directory: "allow", bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny", "permission.question must be forced to 'deny' regardless of the stale source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: forces permission.external_directory to 'allow' even when the projectRoot source omits it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extdir-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { question: "deny", bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.external_directory, "allow", "permission.external_directory must be forced to 'allow'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: re-forces the dangerous-command bash deny-list entry when the projectRoot source dropped it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-denylist-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.bash["*"], "allow", "permission.bash['*'] must remain 'allow'");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "permission.bash['git push --force*'] must be re-forced to 'deny' even when the source dropped it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: union-enforces canonical denies without dropping a project-specific extra deny from the source", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extra-deny-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "kubectl delete*": "deny" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.bash["kubectl delete*"],
      "deny",
      "a project-specific extra deny from the source must survive canonical-deny enforcement (union, never replace)",
    );
    assert.equal(cfg.permission.bash["*"], "allow", "permission.bash['*'] must remain 'allow'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: the example-fallback path is ALSO key-enforced when projectRoot has no opencode.json", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-fallback-enforce-");
  try {
    mkdirSync(join(projectRoot, "core", "opencode"), { recursive: true });
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({ permission: { bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny", "fallback-sourced config must also have permission.question forced to 'deny'");
    assert.equal(
      cfg.permission.external_directory,
      "allow",
      "fallback-sourced config must also have permission.external_directory forced to 'allow'",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: preserves the return-shape contract — 'copied' still includes 'opencode.json' when a projectRoot source is written", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-return-shape-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: { question: "deny", external_directory: "allow", bash: { "*": "allow" } },
      }),
    );
    const r = seedOpencodeRootConfig(worktree, projectRoot);
    assert.ok(
      Array.isArray(r.copied) && r.copied.includes("opencode.json"),
      "the returned copied array must include 'opencode.json' (task-1's pinned return-shape contract)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: fail-safe on malformed projectRoot opencode.json — falls back to the vendored example, never throws, never leaves a permissive config", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-malformed-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ invalid json");
    mkdirSync(join(projectRoot, "core", "opencode"), { recursive: true });
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "git push --force*": "deny", "rm -rf*": "deny" },
        },
      }),
    );
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "a malformed source config must never throw");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny");
    assert.equal(cfg.permission.external_directory, "allow");
    assert.equal(cfg.permission.bash["*"], "allow");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "malformed source must never propagate into a permissive worktree config — deny-list entries must be intact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: double-fault — malformed projectRoot config AND no readable example candidate — never throws, still writes safe denies from the in-code constant", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-double-fault-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ invalid json");
    // Deliberately no core/opencode/opencode.json.example, no .opencode/opencode.json.example under
    // projectRoot, and no .opencode/opencode.json.example under worktree — a genuine double-fault.
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "a double-fault (malformed source + no example) must never throw");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny");
    assert.equal(cfg.permission.external_directory, "allow");
    assert.equal(cfg.permission.bash["*"], "allow");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "on a double-fault the dangerous-command deny entries must come from the in-code DANGEROUS_BASH_DENYLIST constant — never an allow-all bash lacking denies",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] force-enforces deny entries for the additional dangerous-command classes (sudo, pipe-to-shell, chmod 777, netcat, dd, fork-bomb) alongside the pre-existing git/rm-rf denies", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extra-dangerous-classes-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const bash = cfg.permission.bash;
    const additionalDangerousClasses = [
      "sudo *",
      "* | sh",
      "* | bash",
      "chmod 777*",
      "chmod -R 777*",
      "nc *",
      "ncat *",
      "dd if=*",
      ":(){ :|:& };:",
    ];
    for (const key of additionalDangerousClasses) {
      assert.equal(
        bash[key],
        "deny",
        `permission.bash[${JSON.stringify(key)}] must be forced to 'deny' as an additional dangerous-command class`,
      );
    }
    assert.equal(
      bash["git push --force*"],
      "deny",
      "the pre-existing git push --force* deny must still be present alongside the additional classes",
    );
    assert.equal(
      bash["rm -rf /"],
      "deny",
      "the pre-existing rm -rf / deny must still be present alongside the additional classes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [orphan-state, double-fault] malformed source still seeds permissions + monorepo plugin rewrite when core/opencode/plugin stubs exist", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-double-fault-plugin-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ this is not json");
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "malformed source must not throw when plugin files exist on worktree");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length > 0, "plugin[] must be non-empty");
    assert.ok(
      cfg.plugin.every((p) => String(p).startsWith("./core/opencode/plugin/")),
      `plugin[] must be monorepo-rewritten when only core/opencode/plugin exists, got ${JSON.stringify(cfg.plugin)}`,
    );
    assert.ok(cfg.plugin.some((p) => String(p).includes("obs-eye.ts")), "includes obs-eye");
    assert.equal(cfg.permission.question, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── #315 OC plugin path materialization / monorepo rewrite ─────────────────

test("rewriteOcPluginsToMonorepoCore: maps .opencode/plugin → core/opencode/plugin", () => {
  assert.deepEqual(
    rewriteOcPluginsToMonorepoCore([
      "./.opencode/plugin/entry-gate.ts",
      "./.opencode/plugin/plan-gate.ts",
    ]),
    ["./core/opencode/plugin/entry-gate.ts", "./core/opencode/plugin/plan-gate.ts"],
  );
});

test("seedOpencodeRootConfig: monorepo worktree without .opencode/plugin rewrites plugin[] to core/opencode/plugin and files exist (#ac-1.1 #ac-1.2)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-mono-");
  try {
    writeMonorepoPluginStubs(worktree);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts", "./.opencode/plugin/plan-gate.ts"],
        permission: { bash: { "*": "allow" } },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length > 0, "plugin[] non-empty");
    assert.ok(
      cfg.plugin.every((p) => String(p).startsWith("./core/opencode/plugin/")),
      `expected monorepo rewrite, got ${JSON.stringify(cfg.plugin)}`,
    );
    assert.equal(ocPluginFilesExist(worktree, cfg.plugin), true);
    assert.equal(existsSync(join(worktree, "core/opencode/plugin/entry-gate.ts")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: consumer vendored .opencode/plugin keeps paths (#ac-1.5)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-vendored-");
  try {
    const vendored = join(worktree, ".opencode", "plugin");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(vendored, "entry-gate.ts"), "// vendored\n", "utf8");
    writeFileSync(join(vendored, "plan-gate.ts"), "// vendored\n", "utf8");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts", "./.opencode/plugin/plan-gate.ts"],
        permission: { bash: { "*": "allow" } },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.deepEqual(cfg.plugin, [
      "./.opencode/plugin/entry-gate.ts",
      "./.opencode/plugin/plan-gate.ts",
    ]);
    assert.equal(ocPluginFilesExist(worktree, cfg.plugin), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: no plugin source anywhere → throws fail-closed (#ac-1.3)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-missing-", { bare: true });
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts"],
        permission: { bash: { "*": "allow" } },
      }),
    );
    assert.throws(
      () => seedOpencodeRootConfig(worktree, projectRoot),
      /plugins missing|gates would be dead|First missing/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOcPluginPathsExist: monorepo core plugins → rewritten paths", () => {
  const { root, worktree } = makeSeedDirs("oc-seed-ensure-");
  try {
    writeMonorepoPluginStubs(worktree);
    // only one file needed for this unit test of ensure
    const out = ensureOcPluginPathsExist(worktree, ["./.opencode/plugin/entry-gate.ts"]);
    assert.deepEqual(out, ["./core/opencode/plugin/entry-gate.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#ac-1.4 decideBashDelivery empty gate still denies gh pr (logic regression)", async () => {
  const { decideBashDelivery } = await import("../opencode/plugin/lib/bash-decide.mjs");
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    sessionId: "ses_x",
  });
  assert.equal(d.decision, "deny");
});
