/**
 * @description Permanent regression pin for #490. Any test under core/opencode/plugin that drives
 * a real emitter-capable hook (loop-guard.ts, obs-eye.ts, obs-hand.ts, obs-plan-write.ts,
 * mark-gate.mjs's CLI, plan-write-gate.ts, planner-recovery.ts) without isolating
 * HARNESS_OBSERVABILITY_RUN_PATH inherits whatever real run outbox the test process's environment
 * carries — inside an actual harness session that var points at a live run, so fixture events
 * land in the real feed. This spawns the FULL plugin test corpus (this file excluded, so it does
 * not recursively spawn itself) against a pre-seeded sentinel outbox — mirroring the meta file
 * already existing, the exact shape that reproduced the leak live — and asserts the events log
 * stays byte-identical. A future test that forgets to inject its own outbox turns this red, with
 * the leaked lines quoted in the failure message, instead of depending on a reviewer noticing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = join(dirname(SELF_PATH), "..");
const REPO_ROOT = join(dirname(SELF_PATH), "..", "..", "..", "..");

/** @param {string} root @returns {string[]} every *.test.mjs under root, this file excluded */
function listOtherTestFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listOtherTestFiles(full));
    else if (entry.endsWith(".test.mjs") && full !== SELF_PATH) out.push(full);
  }
  return out;
}

test(
  "#490 regression: the full core/opencode/plugin test corpus never appends to a run outbox that already exists",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-isolation-guard-"));
    try {
      const metaPath = join(dir, "sentinela.json");
      const eventsPath = join(dir, "sentinela.events.jsonl");
      const seeded = '{"type":"seed-sentinel","ts":"2026-01-01T00:00:00.000Z"}\n';
      writeFileSync(metaPath, "{}");
      writeFileSync(eventsPath, seeded);

      const files = listOtherTestFiles(PLUGIN_ROOT);
      assert.ok(
        files.length > 30,
        "sanity: expected the plugin test corpus to be non-trivially large — listOtherTestFiles may be pointed at the wrong directory",
      );

      // node:test refuses a nested `--test` run when NODE_TEST_CONTEXT (set on this very process,
      // since it is itself a child worker of the outer `node --test`) is inherited — it silently
      // skips with "run() is being called recursively" instead of running a single file, which
      // would make this guard a false pass. Strip it so the child actually executes.
      const childEnv = { ...process.env, HARNESS_OBSERVABILITY_RUN_PATH: metaPath };
      delete childEnv.NODE_TEST_CONTEXT;

      const child = spawnSync(process.execPath, ["--test", ...files], {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      });

      assert.equal(
        child.error,
        undefined,
        `the spawned corpus did not complete (timeout or output overflow): ${child.error?.message} signal=${child.signal}`,
      );

      const stdout = child.stdout ?? "";
      const ranCount = /^# tests (\d+)$/m.exec(stdout);
      assert.ok(
        ranCount && Number(ranCount[1]) > 400,
        `sanity: the spawned corpus must actually run (expected 400+ subtests) — got stdout tail:\n${stdout.slice(-500)}\nstderr:\n${child.stderr ?? ""}`,
      );

      // A file that throws at import/parse time is counted as exactly ONE failed subtest instead
      // of the many it contains — `# tests` can still clear the 400 floor while most of a broken
      // file's real tests silently never ran. node:test reports that shape as a "not ok" line whose
      // name IS the file path, so catch it explicitly rather than trusting the aggregate count alone.
      const fileLoadFailures = stdout
        .split("\n")
        .filter((line) => /^not ok \d+ - .*\.test\.mjs$/.test(line));
      assert.deepEqual(
        fileLoadFailures,
        [],
        `a file in the spawned corpus failed to load (import/parse error) — the sweep below it is incomplete:\n${fileLoadFailures.join("\n")}`,
      );

      const after = readFileSync(eventsPath, "utf8");
      assert.equal(
        after,
        seeded,
        `a test in core/opencode/plugin appended fake events into the run outbox instead of injecting ` +
          `its own — see obs-test-isolation.mjs's isolateObservabilityRunPath(). Leaked lines:\n${after.slice(seeded.length)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
