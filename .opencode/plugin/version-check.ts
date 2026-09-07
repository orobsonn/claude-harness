/**
 * @description OC version-check plugin — thin default-export wrapper. OpenCode's real 1.18.7
 * plugin loader crashes (bisected live, 2026-07-27, against a headless `opencode serve` with no
 * attached TUI: `"failed to load plugin" ... "undefined is not an object (evaluating 'b.major')"`,
 * cascading into a broken `/config/providers`) when a plugin file has more than one export. All
 * the actual logic — and everything that needs individual named exports for unit testing — lives
 * in `./lib/version-check-core.ts`, a plain module OpenCode never loads as a plugin. This file
 * must never gain a second export.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { createVersionCheck } from "./lib/version-check-core.ts"

const versionCheck: Plugin = async (context) => createVersionCheck(context)

export default versionCheck
