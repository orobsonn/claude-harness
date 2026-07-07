/**
 * @description VPS blue/green engine auto-updater (pure orchestration + injected seams). The engine
 * — the harness code the crontab runs at `<engineDir>/core/vps/run-cron-*.mjs` — is published as a
 * symlink `~/.claude/harness-core` -> `~/.claude/harness-core-versions/<sha>`. When `main` advances
 * (after an autonomous merge), this prepares the new sha in a SEPARATE, immutable version dir and
 * flips the symlink ATOMICALLY.
 *
 * Why blue/green instead of `git pull` in-place: the engine dir is SHARED by every project's crons
 * (each crontab block points at the same `scriptDir`), and each cron process resolves its imports
 * from the symlink target at spawn time. A `git pull` mutating that tree could hand a concurrently-
 * starting cron a mix of old+new files (git checkout is not atomic across files) — the exact race a
 * per-project run-lock cannot cover. An atomic symlink swap sidesteps it entirely: a process that
 * already resolved the old target keeps running the old (whole, consistent) tree; a process starting
 * after the swap gets the new (whole, consistent) tree. There is never a half-updated instant, so no
 * lock is needed.
 *
 * Fail-safe: if the engine is NOT a managed symlink (a legacy plain-dir install, or an operator's
 * own dev clone), this is a NO-OP — it never mutates an engine it doesn't own.
 */

/**
 * @description True only when both shas are known AND differ. A missing active or remote sha
 * (a failed rev-parse / ls-remote) returns false — fail-closed, never churn the engine on unknown
 * state.
 * @param {string|null|undefined} activeSha
 * @param {string|null|undefined} remoteSha
 * @returns {boolean}
 */
export function needsUpdate(activeSha, remoteSha) {
  return Boolean(activeSha) && Boolean(remoteSha) && activeSha !== remoteSha;
}

/**
 * @description Given every on-disk version dir, the currently-active sha, and the keep-window size,
 * returns the versions to prune. Two versions are NEVER pruned: (1) the active one (even if oldest),
 * and (2) any version younger than `opts.minAgeMs` — a grace window that protects a version a
 * long-running cron may have resolved just before it was swapped out (run-cron-review does a LATE,
 * engine-relative dynamic import of the codex module mid-run, so a version can still be imported
 * minutes after it stops being active; pruning it out from under that import would ENOENT). Among the
 * remaining prunable versions, the (keep-1) most-recent by mtime are kept and the rest pruned.
 * @param {Array<{sha: string, mtimeMs: number, path: string}>} versions
 * @param {string} activeSha
 * @param {number} keep
 * @param {{now?: number, minAgeMs?: number}} [opts] - `now` (epoch ms) + `minAgeMs` grace; omit to disable the grace
 * @returns {Array<{sha: string, mtimeMs: number, path: string}>}
 */
export function versionsToPrune(versions, activeSha, keep, opts = {}) {
  const { now, minAgeMs } = opts;
  const others = versions.filter((v) => v.sha !== activeSha);
  const keptOthers = [...others].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(0, keep - 1));
  const keptShas = new Set([activeSha, ...keptOthers.map((v) => v.sha)]);

  const withinGrace = (v) =>
    typeof now === "number" && typeof minAgeMs === "number" && now - v.mtimeMs < minAgeMs;

  return versions.filter((v) => !keptShas.has(v.sha) && !withinGrace(v));
}

/**
 * @description Orchestrates one engine-update pass over injected seams. Order matters: prepare the
 * new version FULLY before activating (never point the symlink at a half-ready dir), and prune only
 * AFTER activation (keyed on the new active sha, which is thus always in the keep set). A throw from
 * prepareVersion (a failed clone) propagates BEFORE activate, so the previous engine stays live.
 * @param {object} deps
 * @param {() => boolean} deps.isManaged - true iff engineDir is a managed symlink under versionsDir
 * @param {() => string} deps.getActiveSha - sha the symlink currently resolves to ("" on failure)
 * @param {() => string} deps.getRemoteSha - sha of origin/main via ls-remote ("" on failure)
 * @param {(sha: string) => string} deps.prepareVersion - clones sha into an immutable version dir; returns its path
 * @param {(path: string) => void} deps.activate - atomically swaps the engine symlink to point at path
 * @param {() => Array<{sha: string, mtimeMs: number, path: string}>} deps.listVersions
 * @param {(path: string) => void} deps.pruneVersion
 * @param {number} [deps.keep] - versions to retain (default 3)
 * @param {number} [deps.now] - epoch ms, for the prune grace window (default: none → grace disabled)
 * @param {number} [deps.pruneGraceMs] - don't prune a version younger than this (default: none)
 * @returns {{updated: boolean, reason?: string, from?: string, to?: string}}
 */
export function performEngineUpdate(deps) {
  const { isManaged, getActiveSha, getRemoteSha, prepareVersion, activate, listVersions, pruneVersion, keep = 3, now, pruneGraceMs } = deps;

  if (!isManaged()) {
    return { updated: false, reason: "unmanaged-engine" };
  }

  const activeSha = getActiveSha();
  const remoteSha = getRemoteSha();
  if (!needsUpdate(activeSha, remoteSha)) {
    return { updated: false, reason: "up-to-date" };
  }

  const versionPath = prepareVersion(remoteSha);
  activate(versionPath);

  // Prune is best-effort and runs AFTER the (already-committed) symlink swap: a prune failure must
  // NEVER propagate, or it would turn a real, live update into a misleading "failed" — the engine is
  // already on the new sha. Isolate each version's prune so one stubborn dir never blocks the rest.
  for (const stale of versionsToPrune(listVersions(), remoteSha, keep, { now, minAgeMs: pruneGraceMs })) {
    try {
      pruneVersion(stale.path);
    } catch {
      // best-effort cleanup; a leftover old version dir is inert (never active, pruned next pass)
    }
  }

  return { updated: true, from: activeSha, to: remoteSha };
}
