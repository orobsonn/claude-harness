/**
 * @description RETIRED-ENGINE SHIM. The `harness-deps` parser moved to
 * `core/shared/lib/harness-deps.mjs` when `core/vps/` entered retirement (see
 * `core/vps/DEPRECATED.md`) — the Orca selector needs the same parser and must not depend on the
 * retiring engine. This file stays only so the still-installed VPS crons and their frozen oracles
 * (`chain-deps.test.mjs`, `chain-release.mjs`, `cron-a-select.mjs`) keep importing a stable path.
 * Delete it together with the rest of `core/vps/`.
 */
export { parseDependsOn } from "../shared/lib/harness-deps.mjs";
