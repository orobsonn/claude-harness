import * as nodeModule from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { piChildResourceSettings, verifyPiChildBoundResources } from "../lib/pi-child-extensions.mjs";
import { createPiReviewConcurrency, isPiSubagentDescendant } from "../lib/pi-review-concurrency.mjs";
import { readPiReviewConfig } from "../lib/pi-review-config.mjs";
import { ensurePiRuntime, resolveVerifiedPiRuntime } from "../lib/pi-runtime-cache.mjs";

type BridgeDeps = {
  root?: string;
  maxParallelEyes?: number;
  getAgentDir?: () => string;
  loadNativeFactory?: () => Promise<(pi: ExtensionAPI) => unknown>;
};

function resolveHarnessRoot(piRoot: string) {
  return basename(piRoot) === "pi" && basename(dirname(piRoot)) === "core"
    ? resolve(piRoot, "../..")
    : piRoot;
}

function harnessRoot() {
  return resolveHarnessRoot(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

async function loadVerifiedNativeFactory() {
  let runtime = resolveVerifiedPiRuntime();
  if (!runtime.ok) runtime = ensurePiRuntime();
  if (!runtime.ok) {
    throw new Error(`[harness-subagents] ${runtime.reason}. Run harness init/update with target pi or all on this host to prepare the runtime.`);
  }
  const requireFromRuntime = nodeModule.createRequire(runtime.paths.piPackage);
  const { createJiti } = requireFromRuntime("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: true, tsconfigPaths: true });
  return jiti.import(runtime.paths.subagentsExtension, { default: true });
}

/** Harness-owned production composition root for the pinned native extension. */
export default async function harnessSubagents(pi: ExtensionAPI, deps: BridgeDeps = {}) {
  // Child resource loaders can encounter this entrypoint through package
  // autoload. The parent native factory is already alive in this async chain.
  if (isPiSubagentDescendant()) return;

  const root = deps.root ?? harnessRoot();
  const agentDir = (deps.getAgentDir ?? getAgentDir)();
  let configuredMaxParallelEyes = 3;
  try { configuredMaxParallelEyes = readPiReviewConfig(agentDir).maxParallelEyes; }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const maxParallelEyes = deps.maxParallelEyes ?? configuredMaxParallelEyes;
  const nativeFactory = await (deps.loadNativeFactory ?? loadVerifiedNativeFactory)();
  const bridge = createPiReviewConcurrency({
    maxParallelEyes,
    verifyChildBound: (payload: unknown) => verifyPiChildBoundResources(root, payload),
  });
  const result = bridge.wrapNativeFactory(nativeFactory)(pi);

  pi.on("session_start", (_event: unknown, ctx: any) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") return;
    ctx.ui.notify(`Harness parallel reviewers: ${maxParallelEyes}`, "info");
  });
  return result;
}

export const testApi = Object.freeze({ harnessRoot, resolveHarnessRoot, loadVerifiedNativeFactory, piChildResourceSettings });
