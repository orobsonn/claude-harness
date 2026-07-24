/** @description Cutover preflight for global OpenCode harness removal: T11 parity gate, relative project plugins, TRACK readiness, backup/rollback docs, no phase-2 OC VPS artifacts. Dual-mode: node --test runs locked tests; CLI --preflight / --apply --i-confirm-cutover for operator cutover. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { resolveRuntime } from "../core/vps/resolve-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

/** Harness delivery skills that must leave global; personal skills stay. */
export const HARNESS_SKILLS = [
  "authoring-rules",
  "brainstorming",
  "canonical-critical-classes",
  "committing-changes",
  "distilling-learnings",
  "grill",
  "importing-claude-memory",
  "orchestrating-delivery",
  "proposing-improvements",
  "recording-findings",
  "releasing-versions",
  "surveying-codebase",
  "triaging-requests",
];

/** Personal skills allowed to remain in global after cutover. */
export const PERSONAL_SKILLS_KEEP = ["blog-post", "quiz", "copy"];

/** Phase-2 artifact path patterns (T14 autoMerge focus; T12/T13 files allowed post-done) that must NOT exist in phase 1. */
export const PHASE2_FORBIDDEN_GLOBS = [
  "core/shared/lib/ndjson-session-parser.mjs",
  "core/shared/lib/session-result-parser.mjs",
  "core/shared/lib/opencode-ndjson.mjs",
  "core/vps/spawn-opencode-session.mjs",
  "core/vps/opencode-run-driver.mjs",
  "core/vps/run-opencode-session.mjs",
];

// Dual-shape TRACK-row parser (6-column Phase-1/2 + 5-column Phase-0/2b). Extracted to
// scripts/track-parse.mjs so importing it does not drag the whole preflight suite in as a
// side-effect, and so T15/T17 (which live in the 5-column Phase-2b table) parse correctly.
// Re-exported here for backward compatibility with any caller still importing from this module.
export { parseTrackRow } from "./track-parse.mjs";
import { parseTrackRow } from "./track-parse.mjs";

/**
 * @description True when T11 is done and notes mention parity + project-vendored smoke.
 * @param {string} trackText
 * @returns {{ ok: boolean, reason: string, row: object|null }}
 */
export function checkT11ParityGreen(trackText) {
  const row = parseTrackRow(trackText, "T11");
  if (!row) {
    return { ok: false, reason: "T11 row missing from IMPLEMENTATION-TRACK", row: null };
  }
  if (row.status !== "done") {
    return {
      ok: false,
      reason: `T11 status is "${row.status}", must be done before any global delete`,
      row,
    };
  }
  const notes = row.notes.toLowerCase();
  const hasParity =
    /\bparity\b/.test(notes) ||
    /\bmanifest\b/.test(notes) ||
    /\blocked\b/.test(notes);
  // Require positive smoke/vendored signal — avoid matching the word inside "no smoke"
  const hasSmoke =
    /\b(project-vendored\s+smoke|vendored\s+smoke|smoke\s*\+|smoke\s+green|project smoke|project-vendored)\b/.test(
      notes
    ) ||
    (/\bsmoke\b/.test(notes) && !/\bno\s+smoke\b/.test(notes)) ||
    /\bvendored\b/.test(notes);
  if (!hasParity || !hasSmoke) {
    return {
      ok: false,
      reason:
        "T11 notes must record parity green and project-vendored smoke before cutover",
      row,
    };
  }
  return { ok: true, reason: "T11 parity + project-vendored smoke recorded done", row };
}

/**
 * @description T10 must stay pending until T11 parity+smoke notes are done.
 * @param {string} trackText
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkT10PendingUntilReady(trackText) {
  const t11 = checkT11ParityGreen(trackText);
  const t10 = parseTrackRow(trackText, "T10");
  if (!t10) {
    return { ok: false, reason: "T10 row missing from IMPLEMENTATION-TRACK" };
  }
  if (!t11.ok) {
    if (t10.status === "done") {
      return {
        ok: false,
        reason: `T10 is done but readiness failed: ${t11.reason}`,
      };
    }
    // Correct: T10 still pending while T11 not ready
    return {
      ok: true,
      reason: `T10 correctly ${t10.status} while T11 not ready (${t11.reason})`,
    };
  }
  // T11 ready — T10 may be pending (in progress) or done after cutover
  return {
    ok: true,
    reason: `T11 ready; T10 status=${t10.status} (allowed: pending|in_progress|done)`,
  };
}

/**
 * @description Assert plugin paths in a JSON config are project-relative (not absolute home).
 * @param {string} jsonText
 * @param {string} label
 * @returns {{ ok: boolean, reason: string, absolute: string[] }}
 */
export function checkPluginPathsRelative(jsonText, label = "config") {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: `${label}: invalid JSON`, absolute: [] };
  }
  const plugins = json.plugin;
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { ok: true, reason: `${label}: no plugin array (ok for post-cutover global)`, absolute: [] };
  }
  const absolute = [];
  for (const p of plugins) {
    if (typeof p !== "string") continue;
    if (isAbsolute(p) || p.startsWith("~") || p.includes("/.config/opencode/")) {
      absolute.push(p);
    }
  }
  if (absolute.length > 0) {
    return {
      ok: false,
      reason: `${label}: absolute/home plugin paths must be project-relative before global removal`,
      absolute,
    };
  }
  return { ok: true, reason: `${label}: plugin paths are project-relative`, absolute: [] };
}

/**
 * @description Scan project example / vendored configs for relative plugin paths.
 * @param {string} repoRoot
 * @returns {{ ok: boolean, reason: string, checks: object[] }}
 */
export function checkProjectPluginsRelative(repoRoot) {
  const checks = [];
  const candidates = [
    join(repoRoot, "core/opencode/opencode.json.example"),
    join(repoRoot, "opencode.json"),
    join(repoRoot, ".opencode/opencode.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) {
      checks.push({ path, skipped: true });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const res = checkPluginPathsRelative(text, path);
    checks.push({ path, ...res });
  }
  // Example must exist and be relative
  const example = checks.find((c) => c.path.endsWith("opencode.json.example"));
  if (!example || example.skipped) {
    return {
      ok: false,
      reason: "core/opencode/opencode.json.example missing",
      checks,
    };
  }
  if (!example.ok) {
    return { ok: false, reason: example.reason, checks };
  }
  const failed = checks.filter((c) => !c.skipped && c.ok === false);
  if (failed.length > 0) {
    return {
      ok: false,
      reason: failed.map((f) => f.reason).join("; "),
      checks,
    };
  }
  return {
    ok: true,
    reason: "project plugin paths are project-relative",
    checks,
  };
}

/**
 * * @description Fail if phase-2 OC VPS implementation artifacts exist or autoMergeEnabled for opencode. T14 `done` is now allowed (runtime fail-closed gate ocAutoMergeGateOpen, ac-3.3, enforces T12+T13+T15); the static autoMergeEnabled+opencode config-file guard is the load-bearing premature-merge guard and is preserved.
 * @param {string} repoRoot
 * @param {string} trackText
 * @returns {{ ok: boolean, reason: string, found: string[] }}
 */
export function checkNoPhase2Artifacts(repoRoot, trackText) {
  const found = [];
  for (const rel of PHASE2_FORBIDDEN_GLOBS) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) found.push(rel);
  }
  // Heuristic: OC-specific NDJSON session parser under shared
  const sharedLib = join(repoRoot, "core/shared/lib");
  if (existsSync(sharedLib)) {
    for (const name of readdirSync(sharedLib)) {
      const lower = name.toLowerCase();
      if (
        (lower.includes("ndjson") && lower.includes("session")) ||
        (lower.includes("session") && lower.includes("parser") && lower.includes("opencode")) ||
        lower === "opencode-session-result.mjs"
      ) {
        found.push(`core/shared/lib/${name}`);
      }
    }
  }
  // VPS OC session driver files
  const vpsDir = join(repoRoot, "core/vps");
  if (existsSync(vpsDir)) {
    for (const name of readdirSync(vpsDir)) {
      const lower = name.toLowerCase();
      if (
        (lower.includes("opencode") &&
          (lower.includes("spawn") || lower.includes("session") || lower.includes("driver"))) ||
        lower === "run-opencode.mjs"
      ) {
        found.push(`core/vps/${name}`);
      }
    }
  }
  // autoMergeEnabled true for OC-driven merge (config files only — not Claude tests)
  const ocConfigCandidates = [
    join(repoRoot, "core/opencode/harness.routing.json"),
    join(repoRoot, "core/vps/config.example.json"),
    join(repoRoot, "core/vps/fleet.example.json"),
  ];
  for (const path of ocConfigCandidates) {
    if (!existsSync(path)) continue;
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      if (j.autoMergeEnabled === true && resolveRuntime(j) === "opencode") {
        found.push(`${path}: autoMergeEnabled true for OC`);
      }
    } catch {
      /* ignore */
    }
  }

  // T14 is now allowed `done` once the runtime fail-closed gate (ocAutoMergeGateOpen, ac-3.3)
  // mirrors the T12+T13+T15-done TRACK state. The load-bearing guard against premature OC
  // auto-merge is the static autoMergeEnabled+opencode config-file check above — that guard
  // is intentionally preserved. T14's TRACK status is no longer hard-asserted pending here.

  if (found.length > 0) {
    return {
      ok: false,
      reason: `phase-2 OC VPS artifacts or autoMerge+opencode config: ${found.join(", ")}`,
      found,
    };
  }
  return {
    ok: true,
    reason: "no phase-2 OC VPS implementation artifacts; autoMerge+opencode config guard still blocks",
    found: [],
  };
}

/**
 * @description Runbook must document backup and rollback before global delete.
 * @param {string} runbookText
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkRunbookBackupRollback(runbookText) {
  const lower = runbookText.toLowerCase();
  const hasBackup = /\bbackup\b/.test(lower);
  const hasRollback =
    /\brollback\b/.test(lower) ||
    /restore from backup/.test(lower) ||
    /\brestore\b/.test(lower);
  const hasDeleteGate =
    /\bdelete\b/.test(lower) ||
    /\bremove\b/.test(lower) ||
    /\bempt(?:y|ied)\b/.test(lower);
  if (!hasBackup) {
    return { ok: false, reason: "runbook missing backup steps before global delete" };
  }
  if (!hasRollback) {
    return { ok: false, reason: "runbook missing rollback/restore steps" };
  }
  if (!hasDeleteGate) {
    return { ok: false, reason: "runbook missing global delete/remove steps" };
  }
  // Procedure order: explicit "backup before delete" language, or a Backup section
  // that appears before the Apply/delete procedure section.
  const hasExplicitOrder =
    /backup[^\n.]{0,80}before[^\n.]{0,40}(delete|remove|global)/.test(lower) ||
    /before[^\n.]{0,40}(any\s+)?global delete/.test(lower) ||
    /always backup first/.test(lower) ||
    /backup \(required before/.test(lower) ||
    /backup.*before any global delete/.test(lower) ||
    /##\s*\d*\.?\s*backup[\s\S]{0,2000}##\s*\d*\.?\s*(apply|what to remove|delete)/.test(
      lower
    );
  if (!hasExplicitOrder) {
    return {
      ok: false,
      reason: "runbook must document backup before global delete steps",
    };
  }
  return { ok: true, reason: "runbook documents backup and rollback before global delete" };
}

/**
 * @description Full preflight gate — must pass before any global delete.
 * @param {{ repoRoot?: string, trackText?: string, runbookText?: string }} [opts]
 * @returns {{ ok: boolean, steps: object[], blocked_delete: boolean }}
 */
export function runCutoverPreflight(opts = {}) {
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const trackPath = join(repoRoot, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md");
  const runbookPath = join(repoRoot, "scripts/cutover-opencode-global.md");
  const contractPath = join(repoRoot, "docs/specs/oc-port/10-cutover-global.md");

  const trackText =
    opts.trackText ??
    (existsSync(trackPath) ? readFileSync(trackPath, "utf8") : "");
  const runbookText =
    opts.runbookText ??
    [
      existsSync(runbookPath) ? readFileSync(runbookPath, "utf8") : "",
      existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "",
    ].join("\n");

  const steps = [];

  const t11 = checkT11ParityGreen(trackText);
  steps.push({ id: "t11-parity-green", ...t11 });

  const t10 = checkT10PendingUntilReady(trackText);
  steps.push({ id: "t10-track-gate", ...t10 });

  const rel = checkProjectPluginsRelative(repoRoot);
  steps.push({ id: "project-plugins-relative", ...rel });

  const p2 = checkNoPhase2Artifacts(repoRoot, trackText);
  steps.push({ id: "no-phase2", ...p2 });

  const backup = checkRunbookBackupRollback(runbookText);
  steps.push({ id: "backup-rollback-docs", ...backup });

  const ok = steps.every((s) => s.ok);
  return {
    ok,
    blocked_delete: !ok,
    steps,
    message: ok
      ? "preflight PASS — global delete allowed only with --i-confirm-cutover"
      : `preflight FAIL — global delete blocked: ${steps
          .filter((s) => !s.ok)
          .map((s) => s.reason)
          .join("; ")}`,
  };
}

/**
 * @description List harness dirs under global OC config that cutover removes.
 * @param {string} globalDir
 * @returns {{ agents: string[], plugins: string[], tools: string[], skills: string[] }}
 */
export function planGlobalRemovals(globalDir) {
  const agentsDir = join(globalDir, "agents");
  const pluginDir = join(globalDir, "plugin");
  const toolsDir = join(globalDir, "tools");
  const skillsDir = join(globalDir, "skills");

  const list = (dir) =>
    existsSync(dir)
      ? readdirSync(dir).filter((n) => !n.startsWith("."))
      : [];

  const skills = list(skillsDir).filter((s) => HARNESS_SKILLS.includes(s));

  return {
    agents: list(agentsDir),
    plugins: list(pluginDir),
    tools: list(toolsDir),
    skills,
  };
}

/**
 * @description Apply cutover: backup then remove harness from global. Requires confirm.
 * @param {{ globalDir?: string, confirm: boolean, dryRun?: boolean, repoRoot?: string }} opts
 * @returns {{ ok: boolean, reason: string, backupDir?: string, removed?: object }}
 */
export function applyCutover(opts) {
  if (!opts.confirm) {
    return {
      ok: false,
      reason: "refused: operator confirmation required (--i-confirm-cutover)",
    };
  }
  const pre = runCutoverPreflight({ repoRoot: opts.repoRoot || REPO_ROOT });
  if (!pre.ok) {
    return {
      ok: false,
      reason: `refused: preflight failed — ${pre.message}`,
    };
  }

  const globalDir = opts.globalDir || join(homedir(), ".config/opencode");
  if (!existsSync(globalDir)) {
    return { ok: true, reason: "global dir absent — nothing to cut over", removed: {} };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(globalDir, `.backup-cutover-${stamp}`);
  const plan = planGlobalRemovals(globalDir);

  if (opts.dryRun) {
    return {
      ok: true,
      reason: "dry-run: would backup then remove harness pieces",
      backupDir,
      removed: plan,
    };
  }

  mkdirSync(backupDir, { recursive: true });

  const backupOne = (rel) => {
    const src = join(globalDir, rel);
    if (!existsSync(src)) return;
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  };

  backupOne("agents");
  backupOne("plugin");
  backupOne("tools");
  backupOne("skills");
  backupOne("AGENTS.md");
  backupOne("opencode.json");
  if (existsSync(join(globalDir, "opencode.json.example"))) {
    backupOne("opencode.json.example");
  }

  // Remove harness agents / plugins / tools entirely
  for (const rel of ["agents", "plugin", "tools"]) {
    const p = join(globalDir, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // Remove only harness skills; keep personal
  const skillsDir = join(globalDir, "skills");
  if (existsSync(skillsDir)) {
    for (const name of plan.skills) {
      const p = join(skillsDir, name);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  }

  // Strip harness plugin array; keep model, mcp, permission, instructions minimal
  const ocJsonPath = join(globalDir, "opencode.json");
  if (existsSync(ocJsonPath)) {
    let json;
    try {
      json = JSON.parse(readFileSync(ocJsonPath, "utf8"));
    } catch {
      json = {};
    }
    // Remove absolute harness plugins
    if (Array.isArray(json.plugin)) {
      json.plugin = json.plugin.filter((p) => {
        if (typeof p !== "string") return false;
        // Drop any global harness plugin path
        if (p.includes("/.config/opencode/plugin/") || p.includes("entry-gate") || p.includes("plan-gate") || p.includes("loop-guard") || p.includes("harvest-guard")) {
          return false;
        }
        // Keep only if somehow project-relative (unusual in global)
        return !isAbsolute(p) && !p.startsWith("~");
      });
      if (json.plugin.length === 0) delete json.plugin;
    }
    // Point instructions at a minimal personal AGENTS if present
    writeFileSync(ocJsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  }

  // Minimal personal AGENTS.md (no harness delivery loop)
  const agentsMd = join(globalDir, "AGENTS.md");
  writeFileSync(
    agentsMd,
    `# AGENTS.md — personal OpenCode config (post-cutover)

Harness delivery agents/skills/plugins live in **project** \`.opencode/\` only.
If a project is missing the harness: run \`npx @orobsonn/claude-harness init --target opencode\`.

Keep this file for personal prefs only. Provider auth and MCP stay in \`opencode.json\`.
`,
    "utf8"
  );

  return {
    ok: true,
    reason: "cutover applied: harness removed from global; personal skills/auth/MCP kept",
    backupDir,
    removed: plan,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const isCli =
  process.argv.includes("--preflight") ||
  process.argv.includes("--apply") ||
  process.argv.includes("--dry-run-apply");

if (isCli) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--preflight") || (!args.has("--apply") && !args.has("--dry-run-apply"))) {
    const result = runCutoverPreflight();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  if (args.has("--dry-run-apply")) {
    const result = applyCutover({ confirm: true, dryRun: true });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  if (args.has("--apply")) {
    if (!args.has("--i-confirm-cutover")) {
      console.error(
        JSON.stringify({
          ok: false,
          reason:
            "refused: pass --i-confirm-cutover after preflight PASS (operator confirmation boundary)",
        })
      );
      process.exit(1);
    }
    const result = applyCutover({ confirm: true, dryRun: false });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
}

// ─── Locked tests ────────────────────────────────────────────────────────────

describe("cutover-preflight", () => {
  it("t10-preflight: cutover checklist requires T11 parity green before any global delete step", () => {
    const badTrack = `
| T11 | Parity manifesto CI | 08, 00 | pending | | not done |
| T10 | Cutover global OC harness | 10 | pending | | AFTER T11 only |
`;
    const t11 = checkT11ParityGreen(badTrack);
    assert.equal(t11.ok, false, "T11 pending must fail parity gate");

    const pre = runCutoverPreflight({
      trackText: badTrack,
      runbookText:
        "Backup first before any global delete. Rollback: restore from backup. Then delete harness.",
      repoRoot: REPO_ROOT,
    });
    assert.equal(pre.ok, false);
    assert.equal(pre.blocked_delete, true);

    const applyRefused = applyCutover({
      confirm: true,
      dryRun: true,
      repoRoot: REPO_ROOT,
    });
    // Live TRACK may pass; force fail path via opts by temporarily using bad track through preflight only
    const forced = runCutoverPreflight({
      trackText: badTrack,
      runbookText:
        "1. Backup global config. 2. Rollback instructions. 3. Global delete of harness.",
      repoRoot: REPO_ROOT,
    });
    assert.equal(forced.blocked_delete, true, "delete blocked when T11 not green");

    // Live repo: T11 is done — preflight may pass overall
    const live = checkT11ParityGreen(
      readFileSync(join(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md"), "utf8")
    );
    assert.equal(live.ok, true, "live T11 must be done with parity+smoke notes");
    void applyRefused;
  });

  it("t10-relative: checker asserts project plugin paths are project-relative before global removal", () => {
    const abs = checkPluginPathsRelative(
      JSON.stringify({
        plugin: ["/Users/robson/.config/opencode/plugin/entry-gate.ts"],
      })
    );
    assert.equal(abs.ok, false);
    assert.ok(abs.absolute.length > 0);

    const rel = checkPluginPathsRelative(
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts", "./.opencode/plugin/plan-gate.ts"],
      })
    );
    assert.equal(rel.ok, true);

    const project = checkProjectPluginsRelative(REPO_ROOT);
    assert.equal(project.ok, true, project.reason);
  });

  it("t10-track: T10 remains pending until parity and project-vendored smoke notes recorded done", () => {
    const notReady = `
| T11 | Parity | 08 | done | 2026-07-10 | parity-manifest only |
| T10 | Cutover | 10 | done | 2026-07-10 | wrongly done |
`;
    // T11 notes lack smoke/vendored → not ready; T10 done → fail
    const t11 = checkT11ParityGreen(notReady);
    assert.equal(t11.ok, false, "T11 without smoke/vendored notes must fail");
    const gate = checkT10PendingUntilReady(notReady);
    assert.equal(gate.ok, false, "T10 done while T11 not ready must fail");

    const pendingOk = `
| T11 | Parity | 08 | pending | | |
| T10 | Cutover | 10 | pending | | waiting |
`;
    const g2 = checkT10PendingUntilReady(pendingOk);
    assert.equal(g2.ok, true, "T10 pending while T11 pending is correct");

    const liveTrack = readFileSync(
      join(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md"),
      "utf8"
    );
    const liveGate = checkT10PendingUntilReady(liveTrack);
    assert.equal(liveGate.ok, true, liveGate.reason);
  });

  it("t10-backup: runbook documents backup and rollback steps before global delete", () => {
    const runbookPath = join(REPO_ROOT, "scripts/cutover-opencode-global.md");
    const contractPath = join(REPO_ROOT, "docs/specs/oc-port/10-cutover-global.md");
    assert.ok(existsSync(runbookPath), "scripts/cutover-opencode-global.md must exist");
    assert.ok(existsSync(contractPath), "10-cutover-global.md must exist");
    const text =
      readFileSync(runbookPath, "utf8") + "\n" + readFileSync(contractPath, "utf8");
    const res = checkRunbookBackupRollback(text);
    assert.equal(res.ok, true, res.reason);

    const bad = checkRunbookBackupRollback("just delete everything now");
    assert.equal(bad.ok, false);
  });

  it("t10-no-phase2: fails on phase-2 OC VPS artifacts or autoMerge+opencode config; T14 done is now allowed (runtime gate enforces T12+T13+T15)", () => {
    const liveTrack = readFileSync(
      join(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md"),
      "utf8"
    );
    const live = checkNoPhase2Artifacts(REPO_ROOT, liveTrack);
    assert.equal(live.ok, true, live.reason);

    // T14 done is now allowed — the runtime fail-closed gate (ocAutoMergeGateOpen, ac-3.3)
    // enforces T12+T13+T15. The static autoMergeEnabled+opencode config-file guard is the
    // load-bearing premature-merge guard and must still fire. Verify it on a temp repo.
    const tempRoot = mkdtempSync(join(tmpdir(), "cutover-preflight-no-phase2-"));
    const ocDir = join(tempRoot, "core/opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(
      join(ocDir, "harness.routing.json"),
      JSON.stringify({ autoMergeEnabled: true, runtime: "opencode" }),
      "utf8"
    );
    const bad = checkNoPhase2Artifacts(tempRoot, liveTrack);
    assert.equal(bad.ok, false, "autoMergeEnabled+opencode config must still fail phase-2 gate");
    assert.ok(
      bad.found.some((entry) => entry.includes("autoMergeEnabled")),
      `found should include autoMergeEnabled entry, got: ${JSON.stringify(bad.found)}`
    );
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("apply refuses without confirm and without preflight", () => {
    const noConfirm = applyCutover({ confirm: false });
    assert.equal(noConfirm.ok, false);
    assert.match(noConfirm.reason, /confirmation/i);
  });
});
