import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The launcher materializes package defaults in PI_CODING_AGENT_DIR before Pi
 * starts. Do not redirect it here: Pi writes its normal local state there.
 */
export default function harnessBootstrap(_pi: ExtensionAPI) {
  // Explicit ordered boundary before pi-subagents.
}
