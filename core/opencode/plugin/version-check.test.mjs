// locked then-clauses test for version-check — advisory only
import assert from "node:assert"
import test from "node:test"
import versionCheck from "./version-check.ts"
import {
  checkHarnessVersionStale,
  compareSemver,
  createVersionCheck,
  decideStale,
  parseSemver,
  resolveProjectRoot,
  resolveRemoteTag,
} from "./lib/version-check-core.ts"

test("version-check is advisory only", () => {
  assert.ok(versionCheck) // exercises advisory no-block path
})

test("version-check factory remains advisory when the catalog is healthy", async () => {
  const hooks = await versionCheck({ directory: process.cwd() })
  assert.deepEqual(hooks, {})
})

// --- TUI toast permanently retired (bisected live incident, 2026-07-27) --------------------
//
// Bisected against a real, headless `opencode serve` process with no attached TUI: merely
// CALLING `client.tui.showToast(...)` — awaited, fire-and-forget, any shape — crashed the server
// hard enough to break unrelated endpoints (`/config/providers`). Removing catalog-health or
// staleness logic never reproduced the crash; removing this one call always fixed it. The failure
// is inside the vendored OpenCode binary's own toast/session RPC handling, not in anything on our
// side of the call, so no promise-handling pattern here makes it safe to invoke. `deliverAdvisory`
// no longer touches `client` at all — these tests pin that the advisory channel is `warn`-only and
// that `client` is accepted-but-ignored by `createVersionCheck` (a plugin author cannot silently
// reintroduce the toast without a passing-`client`-does-nothing test going red first).

test("version-check delivers the catalog advisory through warn — client is accepted but never touched", async () => {
  const warnings = []
  const hooks = await createVersionCheck(
    {
      directory: "/project/nested",
      worktree: "/project",
      client: {
        tui: {
          showToast() {
            throw new Error("must never be called — the toast RPC is retired")
          },
        },
      },
    },
    {
      checkAgentCatalogHealth: (root) => {
        assert.equal(root, "/project")
        return { missing: ["adversary"] }
      },
      agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
      warn: (message) => warnings.push(message),
    },
  )
  assert.deepEqual(hooks, {})
  assert.deepEqual(warnings, ["re-vendorize e reabra a sessão"])
})

test("version-check falls back to console.warn when no warn dep is provided, and fails open end to end", async () => {
  const originalWarn = console.warn
  const consoleWarnings = []
  console.warn = (message) => consoleWarnings.push(message)
  try {
    await assert.doesNotReject(createVersionCheck(
      { directory: "/project" },
      {
        checkAgentCatalogHealth: () => ({ missing: ["adversary"] }),
        agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
      },
    ))
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(consoleWarnings, ["re-vendorize e reabra a sessão"])

  const warnings = []
  await assert.doesNotReject(createVersionCheck(
    { directory: "/project" },
    {
      checkAgentCatalogHealth: () => { throw new Error("filesystem unavailable") },
      warn: (message) => warnings.push(message),
    },
  ))
  assert.equal(warnings.length, 1)
})

test("resolveProjectRoot prefers a root worktree over a nested directory", () => {
  assert.equal(
    resolveProjectRoot({ directory: "/project/nested" }, "/project"),
    "/project",
  )
  assert.equal(resolveProjectRoot("/project", undefined), "/project")
})

test("resolveProjectRoot discards a filesystem-root worktree from a non-git directory", () => {
  assert.equal(resolveProjectRoot("/project", "/"), "/project")
  assert.equal(resolveProjectRoot({ directory: "/project/nested" }, "/"), "/project/nested")
  assert.equal(resolveProjectRoot(undefined, "/"), process.cwd())
  assert.equal(resolveProjectRoot("/", "/"), process.cwd())
})


// --- harness-staleness signal (issue #478 ac-2.*) -------------------------------------------

test("parseSemver handles the 3 stamp shapes git describe --tags --always produces (ac-2.4)", () => {
  assert.deepEqual(parseSemver("v0.49.8"), { major: 0, minor: 49, patch: 8 })
  assert.deepEqual(parseSemver("v0.49.8-3-gabc1234"), { major: 0, minor: 49, patch: 8 })
  assert.equal(parseSemver("a1b2c3d"), null)
  assert.equal(parseSemver(""), null)
  assert.equal(parseSemver(undefined), null)
})

test("compareSemver is numeric, not lexical", () => {
  assert.equal(compareSemver({ major: 0, minor: 9, patch: 0 }, { major: 0, minor: 10, patch: 0 }), -1)
  assert.equal(compareSemver({ major: 0, minor: 10, patch: 0 }, { major: 0, minor: 9, patch: 0 }), 1)
  assert.equal(compareSemver({ major: 0, minor: 49, patch: 8 }, { major: 0, minor: 49, patch: 8 }), 0)
})

test("decideStale returns the advisory when the vendored stamp is behind (ac-2.1)", () => {
  const message = decideStale({ localStamp: "v0.49.0", remoteTag: "v0.49.8" })
  assert.ok(message && message.includes("0.49.0") && message.includes("0.49.8"))
  assert.ok(message.includes("/updating-harness"))
})

test("decideStale stays silent when the stamp matches the latest release (ac-2.2)", () => {
  assert.equal(decideStale({ localStamp: "v0.49.8", remoteTag: "v0.49.8" }), null)
  assert.equal(decideStale({ localStamp: "v0.49.9", remoteTag: "v0.49.8" }), null)
})

test("decideStale stays silent on an unparseable (bare SHA) stamp — fail-soft, not a crash", () => {
  assert.equal(decideStale({ localStamp: "a1b2c3d", remoteTag: "v0.49.8" }), null)
  assert.equal(decideStale({ localStamp: "v0.49.0", remoteTag: "a1b2c3d" }), null)
})

test("resolveRemoteTag skips the fetch on a fresh cache hit", () => {
  let fetched = 0
  const tag = resolveRemoteTag({
    nowMs: 1000 + 3_600_000,
    readCache: () => ({ tag: "v0.49.8", cachedAt: 1000 }),
    writeCache: () => { throw new Error("must not write on cache hit") },
    fetchRemoteTag: () => { fetched++; return "v9.9.9" },
    ttlMs: 21_600_000,
  })
  assert.equal(tag, "v0.49.8")
  assert.equal(fetched, 0)
})

test("resolveRemoteTag fetches and caches on a stale/absent cache", () => {
  let writtenArg = null
  const now = 7 * 3_600_000
  const tag = resolveRemoteTag({
    nowMs: now,
    readCache: () => null,
    writeCache: (value) => { writtenArg = value },
    fetchRemoteTag: () => "v0.49.8",
    ttlMs: 21_600_000,
  })
  assert.equal(tag, "v0.49.8")
  assert.deepEqual(writtenArg, { tag: "v0.49.8", cachedAt: now })
})

test("checkHarnessVersionStale emits the advisory for a stale stamp against a mocked newer release (ac-2.1)", () => {
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => "v0.49.0",
    fetchRemoteTag: () => "v0.49.8",
    readCache: () => null,
    writeCache: () => {},
    nowMs: () => 0,
  })
  assert.ok(message && message.includes("v0.49.0") && message.includes("v0.49.8"))
})

test("checkHarnessVersionStale stays silent when the stamp is already current (ac-2.2)", () => {
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => "v0.49.8",
    fetchRemoteTag: () => "v0.49.8",
    readCache: () => null,
    writeCache: () => {},
    nowMs: () => 0,
  })
  assert.equal(message, null)
})

test("checkHarnessVersionStale fails soft (no advisory, no throw) when gh/network is unavailable (ac-2.3)", () => {
  assert.doesNotThrow(() => {
    const message = checkHarnessVersionStale("/project", {
      readLocalVersion: () => "v0.49.0",
      fetchRemoteTag: () => null,
      readCache: () => null,
      writeCache: () => {},
      nowMs: () => 0,
    })
    assert.equal(message, null)
  })
})

test("checkHarnessVersionStale fails soft when there is no vendored stamp at all", () => {
  let fetchCalls = 0
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => null,
    fetchRemoteTag: () => { fetchCalls++; return "v0.49.8" },
  })
  assert.equal(message, null)
  assert.equal(fetchCalls, 0)
})

test("checkHarnessVersionStale fails soft when a dependency throws", () => {
  assert.doesNotThrow(() => {
    const message = checkHarnessVersionStale("/project", {
      readLocalVersion: () => { throw new Error("disk unavailable") },
    })
    assert.equal(message, null)
  })
})

test("createVersionCheck delivers the staleness advisory through the plugin's advisory channel (ac-2.1)", async () => {
  const warnings = []
  const hooks = await createVersionCheck(
    { directory: "/project" },
    {
      checkAgentCatalogHealth: () => ({ missing: [] }),
      readLocalVersion: () => "v0.49.0",
      fetchRemoteTag: () => "v0.49.8",
      readCache: () => null,
      writeCache: () => {},
      nowMs: () => 0,
      warn: (message) => warnings.push(message),
    },
  )
  assert.deepEqual(hooks, {})
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes("v0.49.0") && warnings[0].includes("v0.49.8"))
})

test("createVersionCheck stays silent when the stamp is current (ac-2.2)", async () => {
  const warnings = []
  const hooks = await createVersionCheck(
    { directory: "/project" },
    {
      checkAgentCatalogHealth: () => ({ missing: [] }),
      readLocalVersion: () => "v0.49.8",
      fetchRemoteTag: () => "v0.49.8",
      readCache: () => null,
      writeCache: () => {},
      nowMs: () => 0,
      warn: (message) => warnings.push(message),
    },
  )
  assert.deepEqual(hooks, {})
  assert.deepEqual(warnings, [])
})

test("createVersionCheck never throws and never warns when gh/network is unavailable (ac-2.3)", async () => {
  const warnings = []
  await assert.doesNotReject(createVersionCheck(
    { directory: "/project" },
    {
      checkAgentCatalogHealth: () => ({ missing: [] }),
      readLocalVersion: () => "v0.49.0",
      fetchRemoteTag: () => null,
      readCache: () => null,
      writeCache: () => {},
      nowMs: () => 0,
      warn: (message) => warnings.push(message),
    },
  ))
  assert.deepEqual(warnings, [])
})
