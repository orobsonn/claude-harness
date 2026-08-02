/** @description Restore only validated session-owned state through OpenCode's official compaction hook. */
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"

async function createReinjectStateHooks(
  directory?: string,
  worktree?: string,
  options: { retentionMs?: number; now?: () => number; isAncestorFn?: (sha: string) => boolean; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {},
): Promise<Hooks> {
  const { buildSessionRecovery, recordSessionCompletion, resolveSessionProjectRoot, SESSION_RETENTION_MS, sweepRetainedSessions } =
    await import("./lib/session-state.mjs")
  const root = resolveSessionProjectRoot(directory, worktree)
  const retentionMs = options.retentionMs ?? SESSION_RETENTION_MS
  const now = options.now ?? Date.now
  const isAncestor = options.isAncestorFn ?? ((sha: string) => {
    if (!root || !/^[0-9a-f]{7,64}$/i.test(sha)) return false
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
        cwd: root,
        stdio: "ignore",
        timeout: 2_000,
      })
      return true
    } catch {
      return false
    }
  })
  const sweep = () => {
    if (root) sweepRetainedSessions(root, { retentionMs, now: now(), isAncestor })
  }
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval
  const timer = root ? setIntervalFn(sweep, Math.max(60_000, Math.min(retentionMs || 60_000, 60 * 60_000))) : null
  if (timer && typeof (timer as any).unref === "function") (timer as any).unref()
  sweep()
  return {
    dispose: async () => { if (timer) clearIntervalFn(timer) },
    event: async ({ event }: any) => {
      if (!root || !["session.idle", "session.updated", "session.deleted"].includes(event?.type)) return
      const sessionID = event.type === "session.idle" ? event?.properties?.sessionID : event?.properties?.info?.id
      if (typeof sessionID === "string") {
        recordSessionCompletion(root, sessionID, { eventType: event.type, now: now(), isAncestor })
      }
      sweep()
    },
    "experimental.session.compacting": async (input, output) => {
      if (!root || typeof input?.sessionID !== "string" || !Array.isArray(output?.context)) return
      sweep()
      const recovered = buildSessionRecovery(root, input.sessionID, { isAncestor })
      if (recovered.ok) output.context.push(recovered.context)
    },
  }
}

export const reinjectState: Plugin = async ({ directory, worktree }) =>
  createReinjectStateHooks(directory, worktree)
Object.defineProperty(reinjectState, "testApi", { value: Object.freeze({ createReinjectStateHooks }) })

/** @description OC load contract — default export required. */
export default reinjectState;
