/**
 * @description Contract tests for chain-release.mjs — merge-driven release of chained roadmap
 * issues. A dependent held `harness:queued` is released to `harness:ready` only once EVERY declared
 * dependency has a merged PR (ground truth), stranded to `harness:blocked` if ANY dependency is
 * dead, and left queued while any dependency is still pending. Every `gh`/notify seam is a fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { releaseChainedDependents } from "./chain-release.mjs";

/**
 * @description Fake `gh` seam driven by declarative state:
 *   - queued:  Array<{number, body}> answered for `issue list --label harness:queued`.
 *   - merged:  Set<number> of dependency issue numbers whose `harness/<n>` branch has a merged PR.
 *   - blocked: Set<number> of dependency issue numbers carrying `harness:blocked`.
 *   - editOk:  whether `issue edit` reports {ok:true} (default true).
 * Records every `issue edit` argv into `.edits` and every argv into `.calls`.
 */
function makeFakeGh({ queued = [], merged = new Set(), blocked = new Set(), editOk = true } = {}) {
  const calls = [];
  const edits = [];
  function gh(args) {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return queued.map((q) => ({ number: q.number, body: q.body }));
    }
    if (args[0] === "pr" && args[1] === "list" && args.includes("--state") && args.includes("merged")) {
      const headIdx = args.indexOf("--head");
      const head = headIdx !== -1 ? args[headIdx + 1] : "";
      const n = Number(String(head).replace("harness/", ""));
      return merged.has(n) ? [{ number: 999 }] : [];
    }
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      return { labels: blocked.has(n) ? [{ name: "harness:blocked" }] : [] };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      edits.push(args);
      return { ok: editOk };
    }
    return { ok: true };
  }
  return { gh, calls, edits };
}

function makeSpy() {
  const fn = (...a) => {
    fn.calls.push(a);
  };
  fn.calls = [];
  return fn;
}

function editFor(edits, issueNumber, addLabel) {
  return edits.find(
    (e) => e[2] === String(issueNumber) && e.includes("--add-label") && e.includes(addLabel) && e.includes("--remove-label") && e.includes("harness:queued")
  );
}

test("releaseChainedDependents: releases queued->ready once EVERY dependency has a merged PR", () => {
  const notify = makeSpy();
  const { gh, edits } = makeFakeGh({
    queued: [{ number: 50, body: "```harness-deps\n#12\n#13\n```" }],
    merged: new Set([12, 13]),
  });

  const result = releaseChainedDependents({ gh, notify });

  assert.deepEqual(result.released, [50], "issue 50 must be released once both deps merged");
  assert.ok(editFor(edits, 50, "harness:ready"), "issue 50 must be relabeled queued->ready");
  assert.ok(
    notify.calls.some((a) => a[0] && a[0].type === "chain-released" && a[0].issue === 50),
    "a chain-released event must fire for the released issue"
  );
});

test("releaseChainedDependents: leaves a dependent queued while ANY dependency is still pending", () => {
  const notify = makeSpy();
  const { gh, edits } = makeFakeGh({
    queued: [{ number: 51, body: "```harness-deps\n#12\n#13\n```" }],
    merged: new Set([12]), // 13 not merged yet
  });

  const result = releaseChainedDependents({ gh, notify });

  assert.deepEqual(result.released, [], "must NOT release while a dependency is pending");
  assert.equal(edits.length, 0, "no relabel while pending");
  assert.equal(notify.calls.length, 0, "no notification while pending");
});

test("releaseChainedDependents: a diamond releases only after its LAST dependency merges", () => {
  const body = "```harness-deps\n#20\n#21\n```";
  // Cycle 1: only #20 merged -> stays queued.
  let fake = makeFakeGh({ queued: [{ number: 60, body }], merged: new Set([20]) });
  assert.deepEqual(releaseChainedDependents({ gh: fake.gh }).released, [], "queued until both merge");

  // Cycle 2: #21 also merged -> released.
  fake = makeFakeGh({ queued: [{ number: 60, body }], merged: new Set([20, 21]) });
  assert.deepEqual(releaseChainedDependents({ gh: fake.gh }).released, [60], "released once the last dep merges");
});

test("releaseChainedDependents: strands queued->blocked + notifies when ANY dependency is dead", () => {
  const notify = makeSpy();
  const { gh, edits, calls } = makeFakeGh({
    queued: [{ number: 70, body: "```harness-deps\n#30\n#31\n```" }],
    merged: new Set([30]),
    blocked: new Set([31]), // dependency 31 is dead
  });

  const result = releaseChainedDependents({ gh, notify });

  assert.deepEqual(result.stranded, [70], "issue 70 must be stranded when a dependency is blocked");
  assert.deepEqual(result.released, [], "a stranded dependent must NOT be released");
  assert.ok(editFor(edits, 70, "harness:blocked"), "issue 70 must be relabeled queued->blocked");
  assert.ok(
    calls.some((a) => a[0] === "label" && a[1] === "create" && a[2] === "harness:blocked" && a.includes("--force")),
    "the harness:blocked label must be ensured before the cascade relabel"
  );
  assert.ok(
    notify.calls.some((a) => a[0] && a[0].type === "chain-stranded" && a[0].issue === 70),
    "a chain-stranded event must fire so the operator sees the dead subtree"
  );
});

test("releaseChainedDependents: a blocked dependency strands even when another dependency merged", () => {
  const { gh } = makeFakeGh({
    queued: [{ number: 71, body: "```harness-deps\n#40\n#41\n```" }],
    merged: new Set([40]),
    blocked: new Set([41]),
  });
  const result = releaseChainedDependents({ gh });
  assert.deepEqual(result.stranded, [71], "a single dead dependency strands the dependent");
  assert.deepEqual(result.released, [], "must not release a subtree with a dead node");
});

test("releaseChainedDependents: a queued issue with no parseable dependency is skipped (not promoted, not stranded)", () => {
  const { gh, edits } = makeFakeGh({
    queued: [{ number: 80, body: "no deps block here" }],
  });
  const result = releaseChainedDependents({ gh });
  assert.deepEqual(result.skipped, [80], "a no-deps queued issue is skipped");
  assert.deepEqual(result.released, [], "not released");
  assert.deepEqual(result.stranded, [], "not stranded");
  assert.equal(edits.length, 0, "no relabel for a no-deps queued issue");
});

test("releaseChainedDependents: a failed relabel is NOT counted as released", () => {
  const notify = makeSpy();
  const { gh } = makeFakeGh({
    queued: [{ number: 90, body: "```harness-deps\n#12\n```" }],
    merged: new Set([12]),
    editOk: false, // gh issue edit reports failure
  });
  const result = releaseChainedDependents({ gh, notify });
  assert.deepEqual(result.released, [], "a failed relabel must not be counted as released");
  assert.equal(notify.calls.length, 0, "no chain-released notification on a failed relabel");
});

test("releaseChainedDependents: no queued issues is a clean no-op", () => {
  const { gh, edits } = makeFakeGh({ queued: [] });
  const result = releaseChainedDependents({ gh });
  assert.deepEqual(result, { released: [], stranded: [], skipped: [] });
  assert.equal(edits.length, 0);
});
