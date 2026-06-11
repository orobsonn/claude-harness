/**
 * @description SessionStart(compact) hook — re-injects post-compaction context
 * and GCs stale session-keyed state dirs.
 *
 * Job 1 (reinject): when source === "compact", reads triage.json for this session
 * and (optionally) the feature execution plan, emitting a compact summary as
 * additionalContext so the orchestrator resumes with the correct mode/feature/plan.
 *
 * Job 2 (GC): removes session-keyed state dirs under .claude/plans that meet ALL:
 *   - contain triage.json OR gate-state.json (session-state marker)
 *   - do NOT contain execution-plan.json (not a feature plan dir)
 *   - have mtime older than 7 days (isExpired threshold)
 *
 * Fail-open contract: exits 0 on any infra error; injects nothing, deletes nothing
 * on error. The GC is CONSERVATIVE — when in doubt, do NOT delete.
 */

import fs from "node:fs";
import path from "node:path";
import { isExpired, isSafeFeatureId, isSafeSessionId } from "./lib/gate-lib.mjs";

const GC_MAX_AGE_DAYS = 7;
const DEFAULT_PLANS_ROOT = ".claude/plans";

// ---------------------------------------------------------------------------
// Pure reinject builder — no I/O, injectable readFileSync for tests
// ---------------------------------------------------------------------------

/**
 * Builds the additionalContext string for a post-compaction reinject.
 * Returns null when nothing should be injected (triage missing, malformed, etc.).
 *
 * @param {unknown} payload - Parsed SessionStart hook payload
 * @param {{ readFileSync?: Function, plansRoot?: string }} [opts]
 * @returns {string | null} additionalContext string, or null (do not inject)
 */
export function buildReinject(payload, opts = {}) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }

  if (!isSafeSessionId(sessionId)) {
    return null;
  }

  const plansRoot =
    typeof opts.plansRoot === "string" ? opts.plansRoot : DEFAULT_PLANS_ROOT;
  const readFileSyncFn =
    typeof opts.readFileSync === "function" ? opts.readFileSync : fs.readFileSync;

  // Step 1: Read triage.json — required; absent means nothing to inject.
  const triagePath = path.join(plansRoot, sessionId, "triage.json");
  let triage;
  try {
    const raw = readFileSyncFn(triagePath, "utf8");
    triage = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof triage !== "object" || triage === null || Array.isArray(triage)) {
    return null;
  }

  const { mode, feature_id } = triage;
  if (typeof mode !== "string" || typeof feature_id !== "string") {
    return null;
  }

  let context = `[Compaction recovery]\nMode: ${mode}\nFeature: ${feature_id}\n`;

  // Step 2: Optionally enrich with the feature execution plan summary.
  // feature_id comes from on-disk triage.json content — revalidate before any
  // path join to block path traversal. Unsafe id → return triage-only context.
  if (!isSafeFeatureId(feature_id)) {
    return context;
  }

  // Plan missing → inject triage summary only (still useful for resume).
  const planPath = path.join(plansRoot, feature_id, "execution-plan.json");
  try {
    const raw = readFileSyncFn(planPath, "utf8");
    const plan = JSON.parse(raw);
    const taskCount = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
    context += `Plan: ${planPath}\nTasks: ${taskCount}\n`;
  } catch {
    // Plan not found or unparseable — inject without plan details
  }

  return context;
}

// ---------------------------------------------------------------------------
// Pure GC predicate — no I/O
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, path: string, files: string[], mtimeMs: number }} DirEntry
 */

/**
 * Returns the paths of directories that should be GC'd.
 *
 * GC predicate (ALL three conditions must hold):
 *   1. files includes "triage.json" OR "gate-state.json" (session-state marker present)
 *   2. files does NOT include "execution-plan.json" (not a feature plan dir)
 *   3. mtimeMs is older than GC_MAX_AGE_DAYS (stale)
 *
 * Conservative: a missing marker OR the presence of execution-plan.json blocks deletion.
 *
 * @param {DirEntry[]} dirEntries - Shallow dir entries to evaluate
 * @param {number} nowMs - Current time in milliseconds
 * @returns {string[]} Paths of dirs to remove
 */
export function gcTargets(dirEntries, nowMs) {
  const targets = [];
  for (const entry of dirEntries) {
    const hasSessionMarker =
      entry.files.includes("triage.json") || entry.files.includes("gate-state.json");
    const hasFeaturePlan = entry.files.includes("execution-plan.json");
    const stale = isExpired(entry.mtimeMs, nowMs, GC_MAX_AGE_DAYS);
    if (hasSessionMarker && !hasFeaturePlan && stale) {
      targets.push(entry.path);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Impure helpers — fs I/O
// ---------------------------------------------------------------------------

/**
 * Scans the immediate children of plansRoot and returns DirEntry objects.
 * Returns [] on any fs error (fail-open).
 *
 * @param {string} plansRoot - Root directory to scan
 * @returns {DirEntry[]}
 */
function scanPlansDirs(plansRoot) {
  try {
    const dirents = fs.readdirSync(plansRoot, { withFileTypes: true });
    const entries = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dirPath = path.join(plansRoot, dirent.name);
      try {
        const stat = fs.statSync(dirPath);
        const children = fs.readdirSync(dirPath, { withFileTypes: true });
        // Count symlinked entries too: a symlinked execution-plan.json must still
        // block GC of a feature dir (isFile() alone returns false for symlinks).
        const files = children
          .filter((d) => d.isFile() || d.isSymbolicLink())
          .map((d) => d.name);
        entries.push({
          name: dirent.name,
          path: dirPath,
          files,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable/unstat-able dirs — conservative: do not GC what we cannot read
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Combined hook effect — exported for testability
// ---------------------------------------------------------------------------

/**
 * Runs both jobs: GC then reinject.
 * Accepts injectable deps (plansRoot, readFileSync, scan, nowMs) for unit tests.
 * Returns the hookSpecificOutput object if additionalContext should be emitted, else null.
 * Never throws (fail-open).
 *
 * @param {unknown} payload - Parsed SessionStart hook payload
 * @param {{ plansRoot?: string, readFileSync?: Function, scan?: Function, nowMs?: number }} [opts]
 * @returns {{ hookSpecificOutput: { hookEventName: string, additionalContext: string } } | null}
 */
export function handle(payload, opts = {}) {
  const plansRoot =
    typeof opts.plansRoot === "string" ? opts.plansRoot : DEFAULT_PLANS_ROOT;
  const scanFn = typeof opts.scan === "function" ? opts.scan : scanPlansDirs;
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();

  // The current session's own state dir must NEVER be a GC target — a session
  // resumed/compacted >7 days after its last write would otherwise delete its own
  // dir before the reinject read, erasing brainstormed/adversary_fired with no recovery.
  const currentSessionId =
    payload && typeof payload.session_id === "string" ? payload.session_id : null;

  // Job 2: GC — runs on every SessionStart (matcher is compact, so always compact here)
  try {
    const entries = scanFn(plansRoot);
    const targets = gcTargets(entries, nowMs).filter(
      (target) => path.basename(target) !== currentSessionId,
    );
    for (const target of targets) {
      // Belt-and-suspenders: only delete direct children of plansRoot
      const resolvedRoot = path.resolve(plansRoot);
      const resolvedTarget = path.resolve(target);
      if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
        continue; // path-traversal guard
      }
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // fail-open: ignore individual removal errors
      }
    }
  } catch {
    // fail-open: scan error → skip GC entirely
  }

  // Job 1: Reinject — only on source=compact (always true for this matcher, but guard it)
  if (payload?.source === "compact") {
    try {
      const ctx = buildReinject(payload, {
        readFileSync: opts.readFileSync,
        plansRoot,
      });
      if (ctx !== null) {
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: ctx,
          },
        };
      }
    } catch {
      // fail-open
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so test imports do not trigger side effects
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  let result;
  try {
    result = handle(payload);
  } catch {
    process.exit(0);
  }

  if (result !== null) {
    try {
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
      // fail-open: stdout error must not cause non-zero exit
    }
  }

  process.exit(0);
}
