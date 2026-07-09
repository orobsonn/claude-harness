/**
 * @description Contract tests for reaper.mjs's sweepStaleClosedTopics(opts) — the retention sweep
 * that deletes (irreversibly) the Telegram forum topic of a run whose obs-<issue>.json has been
 * `status:'closed'` past `retentionDays`, subject to a blocklist, a chatId identity check, an
 * unconditional "every critical already acked" gate, a hard-cap-relaxed cosmetic-cursor gate, a
 * `prOpen` guard, and pre-delete/pre-unlink identity re-validation (fail-closed on divergence). The
 * function is synchronous in its iteration but fires async `deleteForumTopic` promises, returning
 * `{ retentionDeletes: Array<Promise>, retentionTally: Record<chatId, {attempted, deleted}> }` — every
 * test here awaits `Promise.allSettled(result.retentionDeletes)` before asserting on the downstream
 * `updateMetaIfUnchanged` / `unlinkRunFiles` calls, mirroring how reaper.test.mjs awaits
 * `actions.topicCloses`.
 *
 * sweepStaleClosedTopics does not exist yet in reaper.mjs — every test below is RED until an executor
 * implements it. That is expected; this file is a frozen contract, not a green suite.
 *
 * Every seam ({fn, calls} recorder factories) is an in-memory fake — no real Telegram/fs is ever
 * touched. Assertions are made on the recorded-call arrays (the observables) and on the function's
 * own return value, never on side effects outside the injected opts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sweepStaleClosedTopics } from "./reaper.mjs";

const NOW = 1700000000;
const DAY_SECONDS = 86400;
const DEFAULT_META_PATH = "/root/dev/demo-project/.claude/state/obs-42.json";

/** @description Records every call made to `fn` (as an args array) and delegates to `impl` when given. */
function makeRecorder(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  return { fn, calls };
}

/** @description Builds a fully-eligible meta object with sane defaults, overridable per test. */
function makeMeta(overrides = {}) {
  return {
    issueNumber: 42,
    status: "closed",
    closedAt: NOW - 8 * DAY_SECONDS,
    threadId: 500,
    chatId: -100123,
    cursor: 2,
    criticalSent: [0],
    ...overrides,
  };
}

/**
 * @description Builds one fully-eligible { candidate, readMeta } pair — candidate mirrors what
 * listStaleRuns() pre-reads, readMeta mirrors the identity re-read the sweep performs before the
 * destructive delete and again before the unlink. Both are derived from the SAME meta object so a
 * negative test that overrides one meta field automatically stays consistent across both seams.
 */
function makeEligibleFixture(metaOverrides = {}, eventsOverride) {
  const meta = makeMeta(metaOverrides);
  const events = eventsOverride ?? [{ type: "blocked" }, { type: "picked" }];
  const metaPath = `/root/dev/demo-project/.claude/state/obs-${meta.issueNumber}.json`;
  const candidate = { metaPath, meta, events };
  const readMeta = () => ({ ...meta });
  return { candidate, readMeta, metaPath, meta };
}

/** @description Assembles a full sweepStaleClosedTopics() opts object from a fully-eligible single
 * candidate + sane seam defaults, so each negative test overrides exactly the seam(s) under test. */
function baseSweepOpts(overrides = {}) {
  const defaultFixture = makeEligibleFixture();
  return {
    listStaleRuns: () => [defaultFixture.candidate],
    deleteForumTopic: () => Promise.resolve({ ok: true }),
    updateMetaIfUnchanged: () => true,
    readMeta: defaultFixture.readMeta,
    unlinkRunFiles: () => true,
    prOpen: () => false,
    isCriticalEvent: (event) => event.type === "blocked" || event.type === "failed",
    now: () => NOW,
    resolvedChatId: -100123,
    sharedThreadIds: [613],
    retentionDays: 7,
    hardCapDays: 30,
    maxDeletions: 3,
    ...overrides,
  };
}

test("#ac-1.5 happy path: deleteForumTopic called exactly once with {threadId}, updateMetaIfUnchanged stamps topicDeletedAt, unlinkRunFiles called exactly twice in order (events then meta)", async () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));
  const updateMetaIfUnchanged = makeRecorder(() => true);
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    deleteForumTopic: deleteForumTopic.fn,
    updateMetaIfUnchanged: updateMetaIfUnchanged.fn,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 1, "deleteForumTopic must be called exactly once");
  assert.deepEqual(deleteForumTopic.calls[0][0], { threadId: 500 });

  assert.ok(
    updateMetaIfUnchanged.calls.some((args) => args[2] && "topicDeletedAt" in args[2]),
    "updateMetaIfUnchanged must stamp topicDeletedAt on the happy path"
  );

  assert.equal(unlinkRunFiles.calls.length, 2, "unlinkRunFiles must be called exactly twice");
  assert.deepEqual(unlinkRunFiles.calls[0], [DEFAULT_META_PATH, { what: "events" }], "first unlink must target the events file");
  assert.deepEqual(unlinkRunFiles.calls[1], [DEFAULT_META_PATH, { what: "meta" }], "second unlink must target the meta file");
});

test("#ac-1.9 no-op guard: isCriticalEvent and unlinkRunFiles not being functions returns an empty result without throwing and probes nothing", () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));
  const updateMetaIfUnchanged = makeRecorder(() => true);

  const opts = baseSweepOpts({
    isCriticalEvent: undefined,
    unlinkRunFiles: undefined,
    deleteForumTopic: deleteForumTopic.fn,
    updateMetaIfUnchanged: updateMetaIfUnchanged.fn,
  });

  let result;
  assert.doesNotThrow(() => {
    result = sweepStaleClosedTopics(opts);
  });

  assert.deepEqual(result, { retentionDeletes: [], retentionTally: {} });
  assert.equal(deleteForumTopic.calls.length, 0);
  assert.equal(updateMetaIfUnchanged.calls.length, 0);
});

test("#ac-1.5 updateMetaIfUnchanged stamps topicDeletedAt from now() in epoch SECONDS (< 1e12), never Date.now() milliseconds", async () => {
  const updateMetaIfUnchanged = makeRecorder(() => true);

  const opts = baseSweepOpts({
    now: () => NOW,
    updateMetaIfUnchanged: updateMetaIfUnchanged.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  const stampCall = updateMetaIfUnchanged.calls.find((args) => args[2] && "topicDeletedAt" in args[2]);
  assert.ok(stampCall, "a call stamping topicDeletedAt must exist");
  assert.equal(stampCall[2].topicDeletedAt, NOW);
  assert.ok(stampCall[2].topicDeletedAt < 1e12, "topicDeletedAt must be SECONDS, not milliseconds");
});

test("#ac-1.1 a candidate whose threadId is in sharedThreadIds is NEVER deleted, including under String()-normalized comparison of mixed number/string types", async () => {
  const { candidate, readMeta } = makeEligibleFixture({ threadId: 613 });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    sharedThreadIds: [613],
    deleteForumTopic: deleteForumTopic.fn,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0, "a blocklisted threadId must never be deleted");
  assert.equal(unlinkRunFiles.calls.length, 0, "a blocklisted threadId must never be unlinked");

  const { candidate: candidate2, readMeta: readMeta2 } = makeEligibleFixture({ issueNumber: 43, threadId: 613 });
  const deleteForumTopic2 = makeRecorder(() => Promise.resolve({ ok: true }));
  const unlinkRunFiles2 = makeRecorder(() => true);

  const opts2 = baseSweepOpts({
    listStaleRuns: () => [candidate2],
    readMeta: readMeta2,
    sharedThreadIds: ["613"],
    deleteForumTopic: deleteForumTopic2.fn,
    unlinkRunFiles: unlinkRunFiles2.fn,
  });

  const result2 = sweepStaleClosedTopics(opts2);
  await Promise.allSettled(result2.retentionDeletes ?? []);

  assert.equal(
    deleteForumTopic2.calls.length,
    0,
    "a String()-normalized threadId/sharedThreadIds type mismatch (number vs string) must still block deletion"
  );
  assert.equal(unlinkRunFiles2.calls.length, 0);
});

test("#ac-1.2 a candidate whose meta.chatId differs from resolvedChatId is NEVER deleted", async () => {
  const { candidate, readMeta } = makeEligibleFixture({ chatId: 7 });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    resolvedChatId: 9,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.2 a candidate whose meta has NO chatId key at all is NEVER deleted", async () => {
  const meta = makeMeta();
  delete meta.chatId;
  const metaPath = "/root/dev/demo-project/.claude/state/obs-42.json";
  const candidate = { metaPath, meta, events: [{ type: "blocked" }, { type: "picked" }] };
  const readMeta = () => ({ ...meta });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.4 an unsent critical index (criticalSent: []) blocks deletion even PAST the hard cap — the criticalSent gate is unconditional and the cap never relaxes it", async () => {
  const { candidate, readMeta } = makeEligibleFixture({
    criticalSent: [],
    closedAt: NOW - 40 * DAY_SECONDS,
  });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    hardCapDays: 30,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.4 all criticals sent AND closed past the 30-day hard cap relaxes the cosmetic cursor gate — deletion proceeds even with cursor < events.length", async () => {
  const { candidate, readMeta } = makeEligibleFixture({
    cursor: 0,
    criticalSent: [0],
    closedAt: NOW - 40 * DAY_SECONDS,
  });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    hardCapDays: 30,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 1, "past the hard cap, a fully-critical-acked run must still be deleted even with an undrained cosmetic cursor");
});

test("#ac-1.4 all criticals sent but closed BEFORE the hard cap does NOT relax the cursor gate — cursor < events.length still blocks deletion", async () => {
  const { candidate, readMeta } = makeEligibleFixture({
    cursor: 0,
    criticalSent: [0],
    closedAt: NOW - 8 * DAY_SECONDS,
  });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    hardCapDays: 30,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.5 a candidate whose status is not 'closed' (e.g. 'awaiting-review') is NEVER deleted even when every other gate fully passes", async () => {
  const { candidate, readMeta } = makeEligibleFixture({
    status: "awaiting-review",
    cursor: 2,
    criticalSent: [0],
    closedAt: NOW - 8 * DAY_SECONDS,
  });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.6 a candidate whose issue's PR is still OPEN is NEVER deleted", async () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    prOpen: () => true,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.11 candidates with a null, NaN, or entirely missing closedAt are NEVER deleted", async () => {
  const fixtureNull = makeEligibleFixture({ issueNumber: 51, closedAt: null });
  const fixtureNaN = makeEligibleFixture({ issueNumber: 52, closedAt: NaN });
  const metaNoKey = makeMeta({ issueNumber: 53 });
  delete metaNoKey.closedAt;
  const metaPathNoKey = "/root/dev/demo-project/.claude/state/obs-53.json";
  const candidateNoKey = { metaPath: metaPathNoKey, meta: metaNoKey, events: [{ type: "blocked" }, { type: "picked" }] };

  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [fixtureNull.candidate, fixtureNaN.candidate, candidateNoKey],
    readMeta: (metaPath) => {
      if (metaPath === fixtureNull.metaPath) return fixtureNull.readMeta();
      if (metaPath === fixtureNaN.metaPath) return fixtureNaN.readMeta();
      if (metaPath === metaPathNoKey) return { ...metaNoKey };
      return null;
    },
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0, "null/NaN/missing closedAt must never authorize a deletion for any of the three candidates");
});

test("#ac-1.6 a candidate closed only 2 days ago (inside the 7-day retention window) is NEVER deleted", async () => {
  const { candidate, readMeta } = makeEligibleFixture({ closedAt: NOW - 2 * DAY_SECONDS });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0);
});

test("#ac-1.5 resume: a candidate with topicDeletedAt already stamped skips deleteForumTopic, but unlinkRunFiles still runs (events then meta) after re-validating", async () => {
  const { candidate, readMeta } = makeEligibleFixture({ topicDeletedAt: 1699999000 });
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    listStaleRuns: () => [candidate],
    readMeta,
    deleteForumTopic: deleteForumTopic.fn,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0, "an already-stamped topicDeletedAt must never re-attempt the destructive delete");
  assert.equal(unlinkRunFiles.calls.length, 2, "the unlink chain must still proceed for a resumed candidate");
  assert.deepEqual(unlinkRunFiles.calls[0], [candidate.metaPath, { what: "events" }]);
  assert.deepEqual(unlinkRunFiles.calls[1], [candidate.metaPath, { what: "meta" }]);
});

test("#ac-1.5 a thread-not-found delete ack is treated as already-gone — updateMetaIfUnchanged still stamps topicDeletedAt and unlinkRunFiles proceeds", async () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: false, reason: "thread-not-found" }));
  const updateMetaIfUnchanged = makeRecorder(() => true);
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    deleteForumTopic: deleteForumTopic.fn,
    updateMetaIfUnchanged: updateMetaIfUnchanged.fn,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.ok(
    updateMetaIfUnchanged.calls.some((args) => args[2] && "topicDeletedAt" in args[2]),
    "a thread-not-found ack must still stamp topicDeletedAt (the topic is already gone)"
  );
  assert.equal(unlinkRunFiles.calls.length, 2);
});

test("#ac-1.5 a transient delete failure never stamps topicDeletedAt and never unlinks", async () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: false, reason: "transient" }));
  const updateMetaIfUnchanged = makeRecorder(() => true);
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    deleteForumTopic: deleteForumTopic.fn,
    updateMetaIfUnchanged: updateMetaIfUnchanged.fn,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.ok(
    !updateMetaIfUnchanged.calls.some((args) => args[2] && "topicDeletedAt" in args[2]),
    "a transient delete failure must never stamp topicDeletedAt"
  );
  assert.equal(unlinkRunFiles.calls.length, 0, "a transient delete failure must never trigger the unlink chain");
});

test("#ac-1.3 pre-DELETE identity divergence: readMeta returning a diverged status blocks deleteForumTopic entirely", async () => {
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    readMeta: () => ({ ...makeMeta(), status: "active" }),
    deleteForumTopic: deleteForumTopic.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(deleteForumTopic.calls.length, 0, "a diverged pre-delete identity re-read must block the destructive delete");
});

test("#ac-1.3 pre-UNLINK divergence: a refused CAS (updateMetaIfUnchanged returns false) blocks unlinkRunFiles", async () => {
  const unlinkRunFiles = makeRecorder(() => true);

  const opts = baseSweepOpts({
    updateMetaIfUnchanged: () => false,
    unlinkRunFiles: unlinkRunFiles.fn,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.equal(unlinkRunFiles.calls.length, 0, "a refused CAS must block the unlink chain — the meta diverged between the delete and the write");
});

test("#ac-1.10 maxDeletions caps the number of deletions attempted per sweep", async () => {
  const candidates = [];
  const readMetas = {};
  for (let i = 0; i < 6; i++) {
    const issueNumber = 60 + i;
    const { candidate, readMeta } = makeEligibleFixture({ issueNumber, threadId: 500 + i });
    candidates.push(candidate);
    readMetas[candidate.metaPath] = readMeta;
  }
  const deleteForumTopic = makeRecorder(() => Promise.resolve({ ok: true }));

  const opts = baseSweepOpts({
    listStaleRuns: () => candidates,
    readMeta: (metaPath) => readMetas[metaPath](),
    deleteForumTopic: deleteForumTopic.fn,
    maxDeletions: 5,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.ok(deleteForumTopic.calls.length <= 5, "deleteForumTopic must never be called more than maxDeletions times");
  assert.equal(deleteForumTopic.calls.length, 5, "with 6 eligible candidates and maxDeletions:5, exactly 5 deletes must be attempted");
});

test("#ac-1.9 a synchronous throw from one candidate's deleteForumTopic does not stop the sweep from processing the next candidate", async () => {
  const fixtureA = makeEligibleFixture({ issueNumber: 70, threadId: 700 });
  const fixtureB = makeEligibleFixture({ issueNumber: 71, threadId: 701 });

  const calls = [];
  const deleteForumTopic = (input) => {
    calls.push(input);
    if (input.threadId === 700) {
      throw new Error("boom");
    }
    return Promise.resolve({ ok: true });
  };

  const opts = baseSweepOpts({
    listStaleRuns: () => [fixtureA.candidate, fixtureB.candidate],
    readMeta: (metaPath) => {
      if (metaPath === fixtureA.metaPath) return fixtureA.readMeta();
      if (metaPath === fixtureB.metaPath) return fixtureB.readMeta();
      return null;
    },
    deleteForumTopic,
  });

  let result;
  assert.doesNotThrow(() => {
    result = sweepStaleClosedTopics(opts);
  });
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.ok(calls.some((c) => c.threadId === 700), "the throwing candidate must still be attempted");
  assert.ok(calls.some((c) => c.threadId === 701), "the second candidate must still be attempted despite the first throwing synchronously");
});

test("#ac-1.8 retentionTally counts only ATTEMPTED deletions per chatId — a guard-skipped candidate never increments attempted", async () => {
  const fixtureTransient = makeEligibleFixture({ issueNumber: 80, threadId: 800 });
  const fixtureBlocked = makeEligibleFixture({ issueNumber: 81, threadId: 613 });

  const deleteForumTopic = (input) => {
    if (input.threadId === 800) return Promise.resolve({ ok: false, reason: "transient" });
    return Promise.resolve({ ok: true });
  };

  const opts = baseSweepOpts({
    listStaleRuns: () => [fixtureTransient.candidate, fixtureBlocked.candidate],
    readMeta: (metaPath) => {
      if (metaPath === fixtureTransient.metaPath) return fixtureTransient.readMeta();
      if (metaPath === fixtureBlocked.metaPath) return fixtureBlocked.readMeta();
      return null;
    },
    sharedThreadIds: [613],
    deleteForumTopic,
  });

  const result = sweepStaleClosedTopics(opts);
  await Promise.allSettled(result.retentionDeletes ?? []);

  assert.deepEqual(
    result.retentionTally[String(-100123)],
    { attempted: 1, deleted: 0 },
    "only the attempted-and-failed transient delete counts toward attempted; the blocklist-guard-skipped candidate must not"
  );
});
