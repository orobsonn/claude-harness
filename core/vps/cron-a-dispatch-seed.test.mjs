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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedOpencodeRootConfig } from "./cron-a-dispatch.mjs";

/** @description Fresh temp root with projectRoot + worktree dirs, plus a cleanup callback. */
function makeSeedDirs(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectRoot = join(root, "proj");
  const worktree = join(root, "wt");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
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

test("seedOpencodeRootConfig: [orphan-state, double-fault] on a genuine double-fault (malformed source AND no readable example), the worktree opencode.json still carries a non-empty plugin array including './.opencode/plugin/obs-eye.ts'", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-double-fault-plugin-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ invalid json");
    // Deliberately no core/opencode/opencode.json.example, no .opencode/opencode.json.example under
    // projectRoot, and no .opencode/opencode.json.example under worktree — a genuine double-fault,
    // reusing the same setup as the double-fault test above.
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "a double-fault (malformed source + no example) must never throw");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.ok(
      Array.isArray(cfg.plugin) && cfg.plugin.length > 0,
      "even in the degenerate double-fault path, the seeded config must carry a non-empty 'plugin' array — never omitted",
    );
    assert.ok(
      cfg.plugin.includes("./.opencode/plugin/obs-eye.ts"),
      "the canonical plugin list must include './.opencode/plugin/obs-eye.ts' even on a double-fault",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
