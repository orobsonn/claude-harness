/** @description OC version-check plugin — advisory only, no blocking. */
import type { Plugin } from "@opencode-ai/plugin"

export const versionCheck: Plugin = ({ app, client }) => ({
  "chat.message": async (input, output) => {
    // advisory only (no block)
  },
})
