/**
 * @description Two guards for #834 (retirement of `core/notify/notify-telegram.mjs` and
 * `core/notify/scoped-env.mjs`):
 *
 *   1. "stays deleted" tripwire — the retired module and directory must never come back by
 *      accident. If a future session wants to re-add them, this test forces it to revisit #834's
 *      decision (see docs/vps-retirement.md) rather than silently resurrecting a caller-less module.
 *
 *   2. cross-shell producer vocabulary — the retired Telegram renderer's `FEED_ALLOWLIST` doc
 *      comment pointed at a curated set of event-type strings that both shells' independent
 *      producers must agree on (`core/shared/lib/obs-event-types.mjs` is that vocabulary's new,
 *      shell-neutral home). This test scans every LIVE producer of an observability-outbox event —
 *      derived from disk, not hardcoded to `["claude-code","opencode"]` (#ac-X.2) — and asserts every
 *      event-type string literal it emits is either a curated type or one of the two known
 *      audit-only exceptions (`regate-pending`, `eye` — `attempt-started` is already a curated
 *      member, see obs-event-types.mjs, so it is NOT an exception here).
 *
 * This file is deliberately shell-neutral (`core/__tests__/`, not an OC-only or CC-only plugin
 * test): `core/notify/` was neither OC-only nor an engine, so filing its absence guard inside
 * `core/opencode/plugin/oc-only-engine-absence.test.mjs` would misfile it and re-teach a shell
 * asymmetry that was never there.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CURATED_EVENT_TYPES } from "../shared/lib/obs-event-types.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const CORE = path.join(REPO_ROOT, "core");

// Audit-only event types that are DELIBERATELY not curated members: `regate-pending` is an audit
// record only, never rendered/consumed; `eye` is curated CONDITIONALLY on `event.role`
// (see EYE_CURATED_ROLES in obs-event-types.mjs), never as a flat type. `attempt-started` is NOT
// listed here — it already is a curated member.
const AUDIT_ONLY_EXCEPTIONS = new Set(["regate-pending", "eye"]);

/** @returns {string[]} every top-level directory under core/ (shells and non-shell alike; the
 * producer scan below is what actually narrows this to real shells). Dirent.isDirectory() is false
 * for a symlink, so a legacy alias directory is never double-walked. */
function shellDirs() {
  return readdirSync(CORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** @returns {string[]} every `.mjs` file under `dir`, skipping node_modules/fixtures/docs/memory. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "fixtures", "docs", "memory", ".git"].includes(entry.name) ? [] : walk(file);
    }
    return entry.name.endsWith(".mjs") ? [file] : [];
  });
}

/** @returns {{file: string, shell: string, source: string}[]} every live (non-test) `.mjs` file
 * under a shell dir that both reads the observability run path AND appends an outbox event —
 * i.e. an actual producer, not merely something that mentions the env var (entry-gate.mjs and
 * bash-decide.mjs read HARNESS_OBSERVABILITY_RUN_PATH but never append; they must NOT show up here). */
function findProducers() {
  return shellDirs().flatMap((shell) =>
    walk(path.join(CORE, shell))
      .filter((file) => !path.basename(file).includes(".test."))
      .map((file) => ({ file, shell, source: readFileSync(file, "utf8") }))
      .filter(
        ({ source }) =>
          source.includes("HARNESS_OBSERVABILITY_RUN_PATH") && /append(Event)?\(|obsAppend\(/.test(source),
      ),
  );
}

/** @returns {string[]} every `type: '...'` / `type: "..."` string literal found in `source`. */
function extractEventTypeLiterals(source) {
  const matches = [...source.matchAll(/type:\s*['"]([a-z][a-z-]*)['"]/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

test("#834 stays deleted: core/notify/notify-telegram.mjs, scoped-env.mjs, and the directory never come back by accident", () => {
  const retiredPaths = ["core/notify/notify-telegram.mjs", "core/notify/scoped-env.mjs", "core/notify"];
  for (const relativePath of retiredPaths) {
    assert.equal(
      existsSync(path.join(REPO_ROOT, relativePath)),
      false,
      `retired path remains (revisit #834 before re-adding — see docs/vps-retirement.md): ${relativePath}`,
    );
  }
});

test("every live producer's event-type string literal is a member of CURATED_EVENT_TYPES or a known audit-only exception", () => {
  const shells = shellDirs();
  assert.ok(shells.length >= 1, "shellDirs() found no directories under core/ — the walk is broken");

  const producers = findProducers();
  assert.ok(
    producers.length >= 2,
    `expected at least 2 live producer files, found ${producers.length} — the producer scan may be broken: ${JSON.stringify(producers.map((p) => p.file))}`,
  );

  const distinctShellsWithProducers = new Set(producers.map((p) => p.shell));
  assert.ok(
    distinctShellsWithProducers.size >= 2,
    `expected producers in at least 2 shells, found only ${JSON.stringify([...distinctShellsWithProducers])} — the walk may not be reaching one of the shells`,
  );

  for (const { file, source } of producers) {
    for (const type of extractEventTypeLiterals(source)) {
      assert.ok(
        CURATED_EVENT_TYPES.has(type) || AUDIT_ONLY_EXCEPTIONS.has(type),
        `${file} emits event type '${type}', which is neither a CURATED_EVENT_TYPES member nor a known audit-only exception`,
      );
    }
  }
});
