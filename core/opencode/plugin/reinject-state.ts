/** @description OC reinject-state plugin — re-read gate-state on compacting and inject ceremony summary. */
import type { Plugin } from "@opencode-ai/plugin"

export const reinjectState: Plugin = ({ app, client }) => ({
  "chat.message": async (input, output) => {
    // on compacting, re-read gate-state and inject ceremony summary
    if (input?.message?.includes("compact")) {
      // placeholder: actual impl would read gate-state and return additionalContext
    }
  },
})
