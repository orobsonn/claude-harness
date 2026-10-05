/** Host-owned limits. No credential, plan or model-profile changes. */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export function readProviderControlConfig(userHome = homedir()) {
  const defaults = { enabled: undefined, maxConcurrent: 2, taskTimeoutMs: 21_600_000 };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(userHome, ".config/claude-harness/provider-request-control.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw new Error("Invalid host provider-request-control.json", { cause: error });
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Host provider-request-control.json must be an object");
  }
  const value = config.verboo;
  if (value === undefined) return defaults;
  if (typeof value === "boolean") return { ...defaults, enabled: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verboo control must be a boolean or object");
  }
  const result = { ...defaults, ...value };
  if (result.enabled !== undefined && typeof result.enabled !== "boolean") throw new Error("verboo.enabled must be boolean");
  if (!Number.isInteger(result.maxConcurrent) || result.maxConcurrent < 1 || result.maxConcurrent > 6) throw new Error("verboo.maxConcurrent must be an integer from 1 to 6 matching the contracted limit");
  if (!Number.isInteger(result.taskTimeoutMs) || result.taskTimeoutMs < 60_000 || result.taskTimeoutMs > 86_400_000) throw new Error("verboo.taskTimeoutMs must be between one minute and 24 hours");
  return result;
}

export function providerTaskTimeoutMs(providerId, userHome) {
  return providerId === "verboo" ? readProviderControlConfig(userHome).taskTimeoutMs : 7_200_000;
}
