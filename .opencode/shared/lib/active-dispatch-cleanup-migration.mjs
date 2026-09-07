/** @description Safe, idempotent update-time sweep for exact retired OC state artifacts. */

import fs from "node:fs";
import path from "node:path";

const RETIRED_PATHS = Object.freeze([
  Object.freeze(["active-dispatch-cleanup-pending.json"]),
  Object.freeze(["ceremony", "spec-adversary-primary.json"]),
]);
const SAFE_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function realDirectChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return { ok: false, reason: "missing" }; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: "unsafe-path" };
  let real;
  try { real = fs.realpathSync(candidate); } catch { return { ok: false, reason: "unreadable-path" }; }
  if (!within(parent, real) || path.dirname(real) !== parent) return { ok: false, reason: "path-escape" };
  return { ok: true, path: real };
}

function resolveRegularTarget(sessionDir, segments) {
  let parent = sessionDir;
  for (const segment of segments.slice(0, -1)) {
    const resolved = realDirectChildDirectory(parent, segment);
    if (!resolved.ok) return resolved;
    parent = resolved.path;
  }
  const target = path.join(parent, segments.at(-1));
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { ok: false, reason: "missing" }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: "unsafe-target" };
  let real;
  try { real = fs.realpathSync(target); } catch { return { ok: false, reason: "unreadable-target" }; }
  if (!within(parent, real) || path.dirname(real) !== parent) return { ok: false, reason: "target-escape" };
  return { ok: true, path: real };
}

/** @description Remove only exact retired files under real, safe session directories. */
export function sweepRetiredDispatchCleanup(projectRoot, { dryRun = false } = {}) {
  const report = { ok: true, dryRun: dryRun === true, removed: [], wouldRemove: [], skipped: [] };
  let root;
  try { root = fs.realpathSync(projectRoot); } catch { return { ...report, ok: false, reason: "project root unreadable" }; }
  const stateRootPath = path.join(root, ".opencode", "plans", ".state");
  try {
    const stateStat = fs.lstatSync(stateRootPath);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) return { ...report, ok: false, reason: "state root unsafe" };
    const stateRoot = fs.realpathSync(stateRootPath);
    if (!within(root, stateRoot)) return { ...report, ok: false, reason: "state root unsafe" };
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!SAFE_SESSION.test(entry.name)) { report.skipped.push({ session: entry.name, reason: "unsafe-session" }); continue; }
      const session = realDirectChildDirectory(stateRoot, entry.name);
      if (!session.ok) { report.skipped.push({ session: entry.name, reason: `unsafe-session-${session.reason}` }); continue; }
      for (const retiredPath of RETIRED_PATHS) {
        const target = resolveRegularTarget(session.path, retiredPath);
        if (!target.ok) {
          if (target.reason !== "missing") {
            report.skipped.push({ session: entry.name, path: retiredPath.join("/"), reason: target.reason });
          }
          continue;
        }
        if (dryRun) report.wouldRemove.push(target.path);
        else {
          fs.unlinkSync(target.path);
          report.removed.push(target.path);
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return { ...report, ok: false, reason: "state sweep failed" };
  }
  return report;
}

export default { sweepRetiredDispatchCleanup };
