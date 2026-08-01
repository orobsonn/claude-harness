/** @description Locked update-time retirement sweep for obsolete dispatch cleanup sentinels. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sweepRetiredDispatchCleanup } from "./active-dispatch-cleanup-migration.mjs";

test("sweep removes only exact safe-session cleanup files and is dry-run/idempotent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-sweep-"));
  try {
    const target = path.join(root, ".opencode", "plans", ".state", "ses-safe", "active-dispatch-cleanup-pending.json");
    const sibling = path.join(root, ".opencode", "plans", ".state", "ses-safe", "keep.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
    fs.writeFileSync(sibling, "{}");
    const dry = sweepRetiredDispatchCleanup(root, { dryRun: true });
    assert.deepEqual(dry.removed, []);
    assert.equal(dry.wouldRemove.length, 1);
    assert.equal(path.basename(dry.wouldRemove[0]), "active-dispatch-cleanup-pending.json");
    assert.equal(fs.existsSync(target), true);
    const real = sweepRetiredDispatchCleanup(root);
    assert.equal(real.removed.length, 1);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(sibling), true);
    assert.deepEqual(sweepRetiredDispatchCleanup(root).removed, []);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-sweep-outside-"));
    const outsideSentinel = path.join(outside, "active-dispatch-cleanup-pending.json");
    fs.writeFileSync(outsideSentinel, "outside");
    const escape = path.join(root, ".opencode", "plans", ".state", "ses-link");
    try { fs.symlinkSync(outside, escape, "dir"); } catch { t.skip("symlinks unavailable"); return; }
    assert.deepEqual(sweepRetiredDispatchCleanup(root).removed, []);
    assert.equal(fs.existsSync(outsideSentinel), true, "session symlink must not delete outside sentinel");
    const safeLink = path.join(root, ".opencode", "plans", ".state", "ses-target-link");
    fs.mkdirSync(safeLink, { recursive: true });
    const linkedTarget = path.join(safeLink, "active-dispatch-cleanup-pending.json");
    fs.symlinkSync(outsideSentinel, linkedTarget, "file");
    sweepRetiredDispatchCleanup(root);
    assert.equal(fs.existsSync(outsideSentinel), true, "target-file symlink must not delete outside sentinel");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sweep rejects a symlinked state root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-sweep-state-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-sweep-state-outside-"));
  try {
    fs.mkdirSync(path.join(root, ".opencode", "plans"), { recursive: true });
    try { fs.symlinkSync(outside, path.join(root, ".opencode", "plans", ".state"), "dir"); } catch { t.skip("symlinks unavailable"); return; }
    const result = sweepRetiredDispatchCleanup(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /state root unsafe/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
