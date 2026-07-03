/**
 * @description Single-runner lock for the VPS cron harness. A lock DIRECTORY under
 * opts.stateDir is the atomic mutex. Two — and only two — filesystem operations are
 * exclusive single-winner primitives, and every state transition is built on one of them:
 *   - mkdirSync(lockDir)            — fresh acquire (EEXIST for every loser).
 *   - renameSync(lockDir -> unique) — reclaim / release (ENOENT for every loser, because the
 *                                     source directory is already gone once one caller wins).
 * Everything else (reading holder.json, writing holder.json) is only ever done inside a lock
 * directory the caller EXCLUSIVELY holds, so it needs no further guarding.
 *
 * Persisted holder record shape (JSON, inside lockDir):
 *   { pid: number, acquire_ts: number, tmux_session_id?: string }
 * (tmux_session_id is absent until register() has been called.)
 *
 * Liveness precedence (see acquire()):
 *   - Once registered with a tmux_session_id -> liveness is decided by opts.tmuxHasSession
 *     ALONE; the recorded pid is never consulted again.
 *   - Not yet registered -> liveness is decided by opts.kill on the recorded pid, but only
 *     reclaimed once (opts.now() - holder.acquire_ts) >= opts.registration_grace_seconds — a
 *     holder still inside its acquire->register window is never mistaken for dead.
 *
 * Crash safety: the only durable artifacts a mid-operation crash can leave are quarantined
 * side directories (`run.lock.reap.*` / `run.lock.rel.*`) and private `holder.*.tmp` files.
 * None of them shares the live `run.lock` name, so none can ever block a future mkdir of the
 * live lock — a dead/corrupt holder can never brick the project forever.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const LOCK_DIR_NAME = "run.lock";
const HOLDER_FILE_NAME = "holder.json";
const DEFAULT_REGISTRATION_GRACE_SECONDS = 120;

function lockDirPath(stateDir) {
  return join(stateDir, LOCK_DIR_NAME);
}

function holderFileIn(dir) {
  return join(dir, HOLDER_FILE_NAME);
}

/** @description A fresh, process-unique sibling path for lockDir, e.g. `run.lock.reap.<pid>.<rand>`. */
function quarantinePath(stateDir, kind) {
  return `${lockDirPath(stateDir)}.${kind}.${process.pid}.${randomUUID()}`;
}

/**
 * @description Reads and parses the holder.json inside a given directory. Returns null for
 * every failure mode (dir/file absent, holder not yet written by a concurrent acquirer, or a
 * missing/corrupt record) — callers decide meaning from context, never treating null as a crash.
 */
function readHolderFrom(dir) {
  try {
    return JSON.parse(readFileSync(holderFileIn(dir), "utf8"));
  } catch {
    return null;
  }
}

function readHolderRecord(stateDir) {
  return readHolderFrom(lockDirPath(stateDir));
}

/**
 * @description Atomically persists the holder record inside a lock directory the caller
 * exclusively holds. Writes to a private, per-writer temp file then renames — rename is atomic
 * on the same filesystem, so a reader only ever sees a fully-formed old or new file, never a
 * half-written one behind a crash.
 */
function writeHolderRecord(dir, holder) {
  const finalPath = holderFileIn(dir);
  const tmpPath = join(dir, `holder.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(holder), "utf8");
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort temp cleanup; never mask the original failure
    }
    throw err;
  }
}

/**
 * @description Reinstates a quarantined holder directory back into place WITHOUT ever renaming a
 * directory onto lockDir. This is the single restore primitive shared by both the reclaim
 * CAS-mismatch path and the release not-ours path.
 *
 * Why never renameSync(quarantine -> lockDir): rename(2) over an EMPTY target directory silently
 * REPLACES it (only a NON-empty target throws ENOTEMPTY). acquire() does mkdirSync(lockDir) and
 * then writes holder.json as a SEPARATE step, so there is a real window where lockDir is an empty
 * directory. A directory-rename restore overlapping that window would silently clobber a fresh
 * acquirer's freshly-created empty lockDir — both callers would then believe they own the lock
 * (double-acquire). Instead we reinstate via the SAME atomic single-winner primitive as fresh
 * acquire: mkdirSync(lockDir). EEXIST => a fresh acquirer or another reclaimer already owns
 * lockDir; we do NOT overwrite it and simply drop our quarantined copy. On success we exclusively
 * hold a fresh EMPTY lockDir and move ONLY the holder.json FILE in (a file rename onto a
 * nonexistent target — atomic and safe). After this, no code path ever renames a directory onto
 * lockDir: the only exclusive ops are mkdirSync(lockDir) (single-winner EEXIST) and
 * renameSync(lockDir -> UNIQUE) (single-winner ENOENT for losers).
 *
 * IRREDUCIBLE RESIDUAL (documented, not eliminable): this restore is only reached on a
 * remove-then-recreate path — the live lockDir was already renamed away to `quarantine` before the
 * caller discovered it should not have destroyed it (a reclaim CAS-mismatch where the holder we
 * renamed away turns out to be a LIVE newer owner, not the dead snapshot we judged). Between that
 * removal and this mkdir claim, a fresh acquirer can win mkdirSync(lockDir); our claim then gets
 * EEXIST and we drop the quarantined owner — so a reinstated owner can be DISPLACED by a fresh
 * acquirer in that microsecond gap.
 *   (a) Why irreducible: a pure-filesystem lock that must OUTLIVE its creating process (the
 *       detached-session model) rules out flock(2), whose advisory lock dies with the fd. A
 *       persistent fs lock's reclaim is therefore inherently remove-then-create, and thus
 *       non-atomic on a CAS-mismatch — there is no primitive that atomically "put it back only if
 *       still absent AND keep the old contents".
 *   (b) Defense-in-depth-covered: the run-lock is layer 1 of THREE independent anti-double-run
 *       guards. Layer 2 is the `harness:in-progress` issue-label exclusion (cron-a-select skips
 *       in-progress issues). Layer 3 is `harness/<issue>` branch/worktree uniqueness (a second
 *       `git worktree add -b harness/<n>` fails). Either catches this rare lock-layer race before
 *       it can produce two colliding same-issue worktrees.
 *   (c) Bounded: the displacement requires a 3-way microsecond overlap under contention.
 */
function reinstateHolderViaClaim(lockDir, quarantine) {
  try {
    mkdirSync(lockDir);
  } catch (err) {
    // EEXIST: a fresh acquirer or another reclaimer already owns lockDir — never overwrite it.
    if (err.code === "EEXIST") {
      rmSync(quarantine, { recursive: true, force: true });
      return;
    }
    throw err;
  }
  // We exclusively hold a fresh empty lockDir — move ONLY the holder.json file back in.
  try {
    renameSync(holderFileIn(quarantine), holderFileIn(lockDir));
  } catch {
    // Quarantine carried no readable holder.json (e.g. a mid-write acquirer we grabbed) — leave
    // lockDir empty; acquire()'s mtime-based ambiguity path will resolve it. Never mask the
    // reinstate by throwing here.
  }
  rmSync(quarantine, { recursive: true, force: true });
}

/**
 * @description Best-effort, non-blocking orphan GC run opportunistically at the top of acquire().
 * A mid-operation crash can leave quarantined side directories (`run.lock.reap.*` / `run.lock.rel.*`)
 * or private `*.tmp` files behind. None shares the live `run.lock` name so none can brick a future
 * acquire, but they accumulate — sweep any older than a wide window (registration_grace_seconds * 4
 * by mtime). Wrapped so any failure is swallowed: GC must NEVER break acquire.
 */
function gcOrphans(stateDir, nowSeconds, graceSeconds) {
  const cutoff = nowSeconds - graceSeconds * 4;
  let entries;
  try {
    entries = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const isOrphan =
      name.startsWith(`${LOCK_DIR_NAME}.reap.`) ||
      name.startsWith(`${LOCK_DIR_NAME}.rel.`) ||
      name.endsWith(".tmp");
    if (!isOrphan) continue;
    try {
      const full = join(stateDir, name);
      const st = statSync(full);
      if (Math.floor(st.mtimeMs / 1000) < cutoff) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // best-effort: a vanished or newly-busy entry is fine to skip.
    }
  }
}

/**
 * @description Atomically reclaims a lock dir judged stale, using renameSync as the exclusive
 * single-winner primitive. Exactly one concurrent reclaimer renames the live lockDir out from
 * under the rest (losers get ENOENT); the winner then verifies — under exclusive ownership of
 * the quarantined dir — that what it grabbed is still the exact holder it judged stale. If a
 * different reclaimer had already installed a FRESH live holder in the gap between this caller's
 * liveness judgment and its rename, the winner renames that dir back into place (restore) and
 * loses, so it can never delete a newer owner's live lock. When the snapshot still matches, the
 * winner drops the quarantine and falls through to the fresh-acquire path (mkdirSync(lockDir)),
 * which a fresh acquirer may still have won in the gap (EEXIST -> acquired:false).
 *
 * Ambiguity (holderless) reclaim safety: when expectedStaleJson is null the caller judged a
 * HOLDERLESS dir stale purely by its age. After winning the rename the quarantine's holder may
 * STILL be null for two very different reasons: (1) it is the genuinely-stuck/corrupt dir we
 * judged, or (2) it is a fresh acquirer's brand-new lockDir caught in the microscopic window
 * between its mkdirSync and its holder.json write. A null==null match alone cannot tell them
 * apart, so we re-check the quarantine's mtime: only a dir whose ambiguity age still exceeds the
 * grace window is destroyed; a YOUNG holderless dir is a fresh acquirer mid-write and is
 * reinstated (we lose). This is the same age signal that authorized the reclaim, re-applied to
 * the exact dir we actually grabbed — closing the "reclaimer destroys a fresh winner" race.
 * @param {string} stateDir
 * @param {number} pid
 * @param {() => number} now
 * @param {string | null} expectedStaleJson - JSON.stringify of the holder the caller judged
 *   stale (or null if it judged a missing/corrupt holder stale)
 * @param {number} graceSeconds - grace window; a young holderless quarantine is a fresh acquirer
 * @returns {{acquired: boolean, reclaimedStale?: boolean, acquireTs?: number}}
 */
function attemptAtomicReclaim(stateDir, pid, now, expectedStaleJson, graceSeconds) {
  const lockDir = lockDirPath(stateDir);
  const quarantine = quarantinePath(stateDir, "reap");

  try {
    renameSync(lockDir, quarantine);
  } catch (err) {
    // ENOENT: another reclaimer already renamed the live lock away, or it was released, between
    // our stale-judgment and this rename — we lost the single-winner race, never touch it.
    if (err.code === "ENOENT") return { acquired: false };
    throw err;
  }

  // We now solely own `quarantine`. Confirm it is still the holder we evaluated for liveness —
  // a concurrent reclaimer may have fully reclaimed and installed a fresh LIVE holder in the gap.
  const quarantined = readHolderFrom(quarantine);
  const quarantinedJson = quarantined === null ? null : JSON.stringify(quarantined);
  if (quarantinedJson !== expectedStaleJson) {
    // Not the holder we judged — reinstate the rightful owner via the atomic mkdir-claim (never a
    // directory rename onto lockDir; see reinstateHolderViaClaim for the empty-dir clobber hazard
    // and the irreducible CAS-mismatch displacement window this path carries).
    reinstateHolderViaClaim(lockDir, quarantine);
    return { acquired: false };
  }

  if (expectedStaleJson === null) {
    // Ambiguity reclaim: we grabbed a holderless dir. Only destroy it if it is STILL genuinely old
    // — a young holderless dir is a fresh acquirer between its mkdir and its holder write, which we
    // must never destroy. Re-stat the exact dir we hold and reinstate it if it is young.
    let stillStale = false;
    try {
      const st = statSync(quarantine);
      stillStale = now() - Math.floor(st.mtimeMs / 1000) >= graceSeconds;
    } catch {
      stillStale = false;
    }
    if (!stillStale) {
      reinstateHolderViaClaim(lockDir, quarantine);
      return { acquired: false };
    }
  }

  // Confirmed stale and exclusively ours — discard it and re-acquire fresh.
  rmSync(quarantine, { recursive: true, force: true });
  try {
    mkdirSync(lockDir);
  } catch (err) {
    // A fresh acquirer grabbed the now-free lock in the gap — they win.
    if (err.code === "EEXIST") return { acquired: false };
    throw err;
  }
  const acquireTs = now();
  try {
    writeHolderRecord(lockDir, { pid, acquire_ts: acquireTs });
  } catch (err) {
    // ENOENT: a concurrent reclaimer renamed our just-mkdir'd lockDir away in the mkdir->write
    // window — we did not keep the lock, so we lost the race rather than crash.
    if (err.code === "ENOENT") return { acquired: false };
    throw err;
  }
  return { acquired: true, reclaimedStale: true, acquireTs };
}

/**
 * @description Attempts to acquire the run-lock, reclaiming a stale holder when appropriate.
 * Liveness precedence: once a holder has registered a tmux_session_id, liveness is decided by
 * opts.tmuxHasSession ALONE (the recorded pid is never consulted again). Before registration,
 * liveness is decided by opts.kill on the recorded pid, but only once
 * (opts.now() - holder.acquire_ts) >= opts.registration_grace_seconds — a holder still inside
 * its acquire->register window is never mistaken for dead.
 * @param {object} opts
 * @param {string} opts.stateDir - directory holding the lock file
 * @param {number} opts.pid - caller's own pid, recorded as holder on success
 * @param {() => number} opts.now - clock, returns epoch seconds
 * @param {(pid: number) => void} opts.kill - liveness probe; throws (e.g. ESRCH) when pid is dead
 * @param {(sessionId: string) => boolean} opts.tmuxHasSession - tmux liveness probe
 * @param {number} [opts.registration_grace_seconds] - grace window before an unregistered holder can be reclaimed (default 120)
 * @returns {{acquired: boolean, reclaimedStale?: boolean, acquireTs?: number}}
 */
export function acquire(opts) {
  const {
    stateDir,
    pid,
    now,
    kill,
    tmuxHasSession,
    registration_grace_seconds = DEFAULT_REGISTRATION_GRACE_SECONDS,
  } = opts;

  // Idempotent self-heal: a missing stateDir (first run, or after an external cleanup) must
  // not crash the cron with ENOENT — it should simply behave like "no lock yet".
  mkdirSync(stateDir, { recursive: true });

  // Opportunistic, best-effort orphan sweep — never allowed to break acquire.
  try {
    gcOrphans(stateDir, now(), registration_grace_seconds);
  } catch {
    // GC is pure hygiene; any failure is swallowed so acquire proceeds normally.
  }

  try {
    mkdirSync(lockDirPath(stateDir));
    const acquireTs = now();
    try {
      writeHolderRecord(lockDirPath(stateDir), { pid, acquire_ts: acquireTs });
    } catch (err) {
      // ENOENT: a concurrent reclaimer renamed our just-mkdir'd lockDir away in the mkdir->write
      // window — we did not keep the lock; lose the race rather than crash.
      if (err.code === "ENOENT") return { acquired: false };
      throw err;
    }
    return { acquired: true, acquireTs };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  const holder = readHolderRecord(stateDir);
  if (holder === null) {
    // Lock dir exists but the holder record isn't readable: either a concurrent fresh
    // acquirer is mid-write (holder.json not yet created), or the record is missing/corrupt
    // (e.g. a crash). Use the lock dir's own mtime — updated on every write inside it — as the
    // "how long has this been ambiguous" signal: fresh ambiguity is never reclaimed (the other
    // acquirer is about to finish), but ambiguity older than the registration grace window is
    // treated as a dead holder so a corrupt holder can never brick the project forever.
    let lockDirAgeSeconds;
    try {
      const stat = statSync(lockDirPath(stateDir));
      lockDirAgeSeconds = now() - Math.floor(stat.mtimeMs / 1000);
    } catch {
      // Lock dir vanished between our EEXIST check and this stat (concurrent release) —
      // no confirmed holder to reclaim; caller simply lost the race.
      return { acquired: false };
    }
    if (lockDirAgeSeconds < registration_grace_seconds) {
      return { acquired: false };
    }
    return attemptAtomicReclaim(stateDir, pid, now, null, registration_grace_seconds);
  }

  const isRegistered = "tmux_session_id" in holder;
  let holderAlive;
  if (isRegistered) {
    holderAlive = Boolean(tmuxHasSession(holder.tmux_session_id));
  } else {
    let pidAlive = true;
    try {
      kill(holder.pid);
    } catch {
      pidAlive = false;
    }
    const withinGrace = now() - holder.acquire_ts < registration_grace_seconds;
    holderAlive = pidAlive && withinGrace;
  }

  if (holderAlive) {
    return { acquired: false };
  }

  return attemptAtomicReclaim(stateDir, pid, now, JSON.stringify(holder), registration_grace_seconds);
}

/**
 * @description Attaches a tmux session id to the currently held lock's holder record. When
 * opts.acquireTs is provided, the id is attached only if it still matches the recorded holder
 * (ownership guard, symmetric with release) — a superseded caller never mutates a newer owner's
 * record. When opts.acquireTs is omitted, today's unconditional attach is preserved.
 * @param {string} tmuxId
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {number} [opts.acquireTs]
 * @returns {void}
 */
export function register(tmuxId, opts) {
  const holder = readHolderRecord(opts.stateDir);
  if (holder === null) return;
  if (opts.acquireTs !== undefined) {
    if (holder.acquire_ts !== opts.acquireTs) return;
    // Narrow the TOCTOU window: re-read immediately before the write and bail if the recorded
    // owner changed between our first read and now (a reclaimer installed a newer holder). This
    // shrinks — but cannot fully close — the read->write gap; the write itself is not atomic with
    // the guard, so a swap in the final microseconds is still possible (same irreducible class as
    // the reclaim restore). When acquireTs is omitted, preserve today's unconditional attach.
    const fresh = readHolderRecord(opts.stateDir);
    if (fresh === null || fresh.acquire_ts !== opts.acquireTs) return;
    writeHolderRecord(lockDirPath(opts.stateDir), { ...fresh, tmux_session_id: tmuxId });
    return;
  }
  writeHolderRecord(lockDirPath(opts.stateDir), { ...holder, tmux_session_id: tmuxId });
}

/**
 * @description Releases the run-lock iff the recorded holder's acquire_ts matches
 * opts.acquireTs (ownership guard). Uses the same renameSync single-winner primitive as reclaim:
 * the releaser renames the live lockDir to a private quarantine (ENOENT => a reclaimer already
 * took it => someone else owns it now => no-op), then RE-READS the quarantined holder. If it is
 * still ours we drop it (released). If a reclaimer swapped a newer holder in during the tiny
 * window before our rename, we restore that dir to lockDir — provably never deleting a live newer
 * owner's lock. Idempotent: an absent lock is a no-op, never a throw.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {number} opts.acquireTs
 * @returns {void}
 */
export function release(opts) {
  const { stateDir, acquireTs } = opts;
  const lockDir = lockDirPath(stateDir);

  const holder = readHolderRecord(stateDir);
  if (holder === null) return;
  if (holder.acquire_ts !== acquireTs) return;

  const quarantine = quarantinePath(stateDir, "rel");
  try {
    renameSync(lockDir, quarantine);
  } catch (err) {
    // ENOENT: a reclaimer already renamed the lock away — it is no longer ours to release.
    if (err.code === "ENOENT") return;
    throw err;
  }

  // Won the rename. Re-read under exclusive ownership: only delete if it is still our holder.
  const quarantined = readHolderFrom(quarantine);
  if (quarantined !== null && quarantined.acquire_ts === acquireTs) {
    rmSync(quarantine, { recursive: true, force: true });
    return;
  }

  // A reclaimer installed a newer holder in the gap — reinstate it via the atomic mkdir-claim
  // (never a directory rename onto lockDir; see reinstateHolderViaClaim for the empty-dir clobber
  // hazard and the irreducible CAS-mismatch displacement window this path carries).
  reinstateHolderViaClaim(lockDir, quarantine);
}

/**
 * @description Reads the persisted holder record for the run-lock.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {{pid: number, acquire_ts: number, tmux_session_id?: string} | null}
 */
export function readHolder(opts) {
  return readHolderRecord(opts.stateDir);
}
