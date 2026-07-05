/**
 * @description LIVE end-to-end test that the REAL cron scheduler actually FIRES a crontab line the
 * harness installs — the one thing the hermetic install-crons.test.mjs suite (in-memory fakes) can
 * never prove. It writes a real crontab block via the production `writeCrontab` seam, then waits for
 * the OS cron daemon to run it at the next minute boundary and observes the side effect.
 *
 * OPT-IN by design: it mutates the operator's real crontab and needs a running cron daemon, so it is
 * SKIPPED unless `HARNESS_CRON_E2E=1` — the default `npm test` stays hermetic and fast. Run it
 * deliberately on the box (ideally one without live harness crons):
 *   HARNESS_CRON_E2E=1 node --test core/vps/install-crons-e2e.test.mjs
 *
 * Safety: it snapshots the crontab first and RESTORES the exact original in a finally, so no
 * `harness:e2e-*` residue survives a normal run. The installed line only touches a private temp
 * marker file (no repo/gh/git side effect), and its fence carries the pid for identifiability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { readCrontab, writeCrontab, upsertBlock } from "./install-crons.mjs";

const E2E_ENABLED = process.env.HARNESS_CRON_E2E === "1";
const skip = E2E_ENABLED
  ? false
  : "set HARNESS_CRON_E2E=1 (needs a running cron daemon + a writable crontab) to run the live-scheduler test";

test(
  "install-crons E2E: a crontab line written by writeCrontab is actually FIRED by the real cron scheduler",
  { skip, timeout: 135000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cron-e2e-"));
    const marker = join(dir, "fired");
    const fence = `harness:e2e-${process.pid}`;
    const original = readCrontab();
    try {
      // A line the REAL cron daemon must pick up and fire at the next minute boundary. `touch` is
      // absolute (cron's PATH is minimal) and the marker is a fresh temp path this test owns.
      const line = `* * * * * /usr/bin/touch ${marker}`;
      writeCrontab(upsertBlock(original, fence, line));

      // Cron fires at the top of each wall-clock minute — poll up to ~2 minutes for the marker so a
      // fire that lands just after we install is still observed within one full minute boundary.
      const deadline = Date.now() + 125000;
      let fired = false;
      while (Date.now() < deadline) {
        if (existsSync(marker)) {
          fired = true;
          break;
        }
        await sleep(3000);
      }

      assert.ok(
        fired,
        "the real cron scheduler must FIRE the installed crontab line within ~2 minutes (marker file created)"
      );
    } finally {
      // Restore the EXACT original crontab — bulletproof cleanup, no residual harness:e2e-* block.
      writeCrontab(original);
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
