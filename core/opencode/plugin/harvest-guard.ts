/** @description OC harvest-guard plugin — deny/warn if findings.md missing. */
import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"

export const harvestGuard: Plugin = ({ app, client }) => ({
  "tool.execute.before": async (input) => {
    if (input?.tool === "harvest" && !fs.existsSync("findings.md")) {
      return { decision: "deny", reason: "findings.md missing" }
    }
  },
})
