/** @description Locked update-time retirement sweep for obsolete dispatch cleanup sentinels. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sweepRetiredDispatchCleanup } from "./active-dispatch-cleanup-migration.mjs";

test("sweep removes only exact retired state artifacts and is dry-run/idempotent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-sweep-"));
  try {
    const target = path.join(root, ".opencode", "plans", ".state", "ses-safe", "active-dispatch-cleanup-pending.json");
    const sibling = path.join(root, ".opencode", "plans", ".state", "ses-safe", "keep.json");
    const receipt = path.join(root, ".opencode", "plans", ".state", "ses-safe", "ceremony", "spec-adversary-primary.json");
    const ceremonySibling = path.join(path.dirname(receipt), "keep-receipt.json");
    const otherState = path.join(root, ".opencode", "plans", ".state", "ses-other", "gate-state.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.mkdirSync(path.dirname(otherState), { recursive: true });
    fs.writeFileSync(target, "{}");
    fs.writeFileSync(sibling, "{}");
    fs.writeFileSync(receipt, '{"result":"legacy"}');
    fs.writeFileSync(ceremonySibling, "{}");
    fs.writeFileSync(otherState, "{}");
    const dry = sweepRetiredDispatchCleanup(root, { dryRun: true });
    assert.deepEqual(dry.removed, []);
    assert.equal(dry.wouldRemove.length, 2);
    assert.deepEqual(dry.wouldRemove.map((candidate) => path.basename(candidate)).sort(), [
      "active-dispatch-cleanup-pending.json",
      "spec-adversary-primary.json",
    ]);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(receipt), true);
    const real = sweepRetiredDispatchCleanup(root);
    assert.equal(real.removed.length, 2);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(receipt), false);
    assert.equal(fs.existsSync(sibling), true);
    assert.equal(fs.existsSync(ceremonySibling), true);
    assert.equal(fs.existsSync(otherState), true);
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

    const outsideReceipt = path.join(outside, "spec-adversary-primary.json");
    fs.writeFileSync(outsideReceipt, "outside-receipt");
    const linkedCeremony = path.join(root, ".opencode", "plans", ".state", "ses-ceremony-link", "ceremony");
    fs.mkdirSync(path.dirname(linkedCeremony), { recursive: true });
    fs.symlinkSync(outside, linkedCeremony, "dir");
    sweepRetiredDispatchCleanup(root);
    assert.equal(fs.readFileSync(outsideReceipt, "utf8"), "outside-receipt", "ceremony symlink must not delete outside receipt");
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
