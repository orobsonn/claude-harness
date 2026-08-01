/** @description Safe, idempotent update-time sweep for one retired OC cleanup sentinel. */

import fs from "node:fs";
import path from "node:path";

const RETIRED_NAME = "active-dispatch-cleanup-pending.json";
const SAFE_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** @description Remove only exact retired files under real, safe session directories. */
export function sweepRetiredDispatchCleanup(projectRoot, { dryRun = false } = {}) {
  const report = { ok: true, dryRun: dryRun === true, removed: [], wouldRemove: [], skipped: [] };
  let root;
  try { root = fs.realpathSync(projectRoot); } catch { return { ...report, ok: false, reason: "project root unreadable" }; }
  const stateRoot = path.join(root, ".opencode", "plans", ".state");
  try {
    const stateStat = fs.lstatSync(stateRoot);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) return { ...report, ok: false, reason: "state root unsafe" };
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!SAFE_SESSION.test(entry.name)) { report.skipped.push({ session: entry.name, reason: "unsafe-session" }); continue; }
      const sessionDir = path.join(stateRoot, entry.name);
      let stat;
      try { stat = fs.lstatSync(sessionDir); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) { report.skipped.push({ session: entry.name, reason: "unsafe-session-path" }); continue; }
      let realSession;
      try { realSession = fs.realpathSync(sessionDir); } catch { report.skipped.push({ session: entry.name, reason: "unreadable-session" }); continue; }
      if (!within(stateRoot, realSession) || path.dirname(realSession) !== stateRoot) { report.skipped.push({ session: entry.name, reason: "path-escape" }); continue; }
      const target = path.join(realSession, RETIRED_NAME);
      let targetStat;
      try { targetStat = fs.lstatSync(target); } catch { continue; }
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) { report.skipped.push({ session: entry.name, reason: "unsafe-target" }); continue; }
      if (dryRun) report.wouldRemove.push(target);
      else {
        fs.unlinkSync(target);
        report.removed.push(target);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return { ...report, ok: false, reason: "state sweep failed" };
  }
  return report;
}

export default { sweepRetiredDispatchCleanup };
