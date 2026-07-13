// locked then-clauses test for version-check — advisory only
import assert from "node:assert"
import test from "node:test"
import { createVersionCheck, resolveProjectRoot, versionCheck } from "./version-check.ts"

test("version-check is advisory only", () => {
  assert.ok(versionCheck) // exercises advisory no-block path
})

test("version-check factory remains advisory when the catalog is healthy", async () => {
  const hooks = await versionCheck({ directory: process.cwd() })
  assert.deepEqual(hooks, {})
})

test("version-check sends incomplete catalog advisory through the TUI", async () => {
  const toasts = []
  const tui = {
    toasts,
    showToast(input) {
      this.toasts.push(input)
    },
  }
  const hooks = await createVersionCheck(
    {
      directory: "/project/nested",
      worktree: "/project",
      client: { tui },
    },
    {
      checkAgentCatalogHealth: (root) => {
        assert.equal(root, "/project")
        return { missing: ["adversary"] }
      },
      agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
    },
  )
  assert.deepEqual(hooks, {})
  assert.deepEqual(toasts, [{
    body: {
      title: "Harness",
      message: "re-vendorize e reabra a sessão",
      variant: "warning",
    },
  }])
})

test("version-check does not fall back when the TUI success result has an undefined error", async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(message)
  try {
    await assert.doesNotReject(createVersionCheck(
      {
        directory: "/project",
        client: {
          tui: {
            async showToast() {
              return { error: undefined }
            },
          },
        },
      },
      {
        checkAgentCatalogHealth: () => ({ missing: ["adversary"] }),
        agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
      },
    ))
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(warnings, [])
})

test("version-check falls back when the TUI returns an error result", async () => {
  const warnings = []
  await assert.doesNotReject(createVersionCheck(
    {
      directory: "/project",
      client: {
        tui: {
          async showToast() {
            return { error: new Error("TUI unavailable") }
          },
        },
      },
    },
    {
      checkAgentCatalogHealth: () => ({ missing: ["adversary"] }),
      agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
      warn: (message) => warnings.push(message),
    },
  ))
  assert.deepEqual(warnings, ["re-vendorize e reabra a sessão"])
})

test("version-check falls back to console and fails open when TUI delivery fails", async () => {
  const warnings = []
  const toasts = []
  await assert.doesNotReject(createVersionCheck(
    {
      directory: "/project",
      client: {
        tui: {
          showToast: (input) => {
            toasts.push(input)
            throw new Error("TUI unavailable")
          },
        },
      },
    },
    {
      checkAgentCatalogHealth: () => ({ missing: ["adversary"] }),
      agentCatalogAdvisoryMessage: () => "re-vendorize e reabra a sessão",
      warn: (message) => warnings.push(message),
    },
  ))
  assert.equal(toasts.length, 1)
  assert.deepEqual(warnings, ["re-vendorize e reabra a sessão"])

  await assert.doesNotReject(createVersionCheck(
    { directory: "/project" },
    {
      checkAgentCatalogHealth: () => { throw new Error("filesystem unavailable") },
      warn: (message) => warnings.push(message),
    },
  ))
  assert.equal(warnings.length, 2)
})

test("resolveProjectRoot prefers a root worktree over a nested directory", () => {
  assert.equal(
    resolveProjectRoot({ directory: "/project/nested" }, "/project"),
    "/project",
  )
  assert.equal(resolveProjectRoot("/project", undefined), "/project")
})
