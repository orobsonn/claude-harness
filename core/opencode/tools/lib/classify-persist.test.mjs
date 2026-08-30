/**
 * @description Contract tests for classify-persist.mjs's legacy-sidecar migration — the `fresh`
 * transition must REMOVE pre-existing ceremony sidecar keys from the persisted triage state while
 * leaving every unrelated key intact.
 *
 * REHOMED by issue #807 from `core/vps/cron-a-dispatch-fixmode.test.mjs:516` (with its
 * `runRealClassify` helper), which died with the retired `core/vps/` engine. The delete-safety audit
 * proved this is not redundant coverage: running the whole live suite without the vps test leaves
 * `classify-persist.mjs` lines 16-25 (`mergeGateStateAndRemove`) and 35-36 (the `removeStateKeys`
 * dispatch branch) UNCOVERED, and production reaches them — `core/opencode/tools/classify.ts` passes
 * `removeStateKeys: FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE` on the `fresh` transition.
 * `core/opencode/plugin/marker-authority.test.mjs` looks like coverage but asserts the OPPOSITE
 * invariant — that `mark` never WRITES those keys — not that classify REMOVES pre-existing ones.
 *
 * The `unrelated_fact: "preserve-me"` leg is load-bearing: it is the half that proves the removal is
 * surgical rather than a wholesale state reset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decideClassifyAuthority } from "../../../shared/lib/classify-authority.mjs";
import { decideClassifyTransition } from "../../../shared/lib/classify-stub.mjs";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE, persistClassifyState } from "./classify-persist.mjs";

/**
 * Reconstructs the native classify tool's pure path: authority, transition, then triage-state
 * persistence. Classification deliberately does not create or rewrite the stable feature plan.
 */
function runRealClassify({ root, sessionId, featureId, mode, priorState }) {
  const auth = decideClassifyAuthority({ agent: "", parentSessionId: null, sessionId });
  if (!auth.ok) throw new Error(`classify authority denied: ${auth.reason}`);

  const gsPath = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId });
  if (!gsPath.ok) throw new Error(`invalid gate-state path: ${gsPath.reason}`);
  if (priorState !== undefined) {
    fs.mkdirSync(path.dirname(gsPath.path), { recursive: true });
    fs.writeFileSync(gsPath.path, `${JSON.stringify(priorState)}\n`, "utf8");
  }

  const transition = decideClassifyTransition({
    requestedMode: mode,
    requestedFeatureId: featureId,
    currentMode: undefined,
    currentFeatureId: undefined,
    peakMode: undefined,
    classified: false,
  });
  if (!transition.ok) throw new Error(`classify transition denied: ${transition.reason}`);
  // This helper only reconstructs classify.ts's "fresh" branch (a genuinely cold, never-classified
  // session) — if the transition ever resolves to noop/escalate here, the helper's hand-written
  // statePatch below would silently diverge from what classify.ts actually persists in that branch.
  if (transition.action !== "fresh") {
    throw new Error(`runRealClassify only models the "fresh" transition; got "${transition.action}"`);
  }

  const statePatch = {
    session_id: sessionId,
    feature_id: transition.featureId,
    mode: transition.mode,
    peak_mode: transition.peakMode,
    classified: true,
    triaged: true,
  };

  const persisted = persistClassifyState({
    statePath: gsPath.path,
    statePatch,
    removeStateKeys: FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE,
  });
  if (!persisted.ok) throw new Error(`classify persistence failed: ${persisted.reason}`);
  return persisted.state;
}

test("drift guard: fresh classify removes legacy ceremony sidecars from persisted state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixmode-classify-migration-"));
  try {
    const persistedState = runRealClassify({
      root,
      sessionId: "ses_fixmode_migration",
      featureId: "feat-fixmode-migration",
      mode: "LIGHT",
      priorState: {
        brainstormed_binding: { session_id: "stale" },
        adversary_fired_binding: { session_id: "stale" },
        ceremony_generation: 9,
        ceremony_evidence: { digest: "stale" },
        unrelated_fact: "preserve-me",
      },
    });

    for (const retiredKey of FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE) {
      assert.equal(Object.hasOwn(persistedState, retiredKey), false, `${retiredKey} survived fresh classify`);
    }
    assert.equal(persistedState.classified, true);
    assert.equal(persistedState.unrelated_fact, "preserve-me");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
