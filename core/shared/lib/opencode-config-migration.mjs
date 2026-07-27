/** @description Migrates a vendored project's opencode.json permission block across harness generations. */

/** @description Sidecar filename (lives under `.opencode/`) tracking harness-owned permission keys. */
export const MANIFEST_FILENAME = ".harness-config-manifest.json";

/**
 * Ledger of retired `permission.*` entries. A project's current value for `path` is safe to
 * drop (or force-upgrade to the new generation's value) only when BOTH hold: it still EQUALS
 * `historicalValue` (the operator never touched it) AND the project's own generation is at or
 * before `shippedThroughGeneration` (the last generation that actually shipped this default —
 * a project vendored after that point could never have received it from the harness, so an
 * identical key+value there is the operator's own doing, not a stale harness default). Any
 * other value, or a project generation past the cutoff, is an operator customization and must
 * survive the migration untouched.
 */
export const RETIRED_OC_PERMISSION_ENTRIES = Object.freeze([
  Object.freeze({
    path: Object.freeze(["bash", "npx github:orobsonn/claude-harness#* init*"]),
    historicalValue: "allow",
    // last shipped in v0.45.0 (core/opencode/opencode.json.example); replaced by the pinned #v* set in v0.45.1 (#359)
    shippedThroughGeneration: Object.freeze({ major: 0, minor: 45, patch: 0 }),
  }),
  Object.freeze({
    path: Object.freeze(["bash", "npx -y github:orobsonn/claude-harness#* init*"]),
    historicalValue: "allow",
    shippedThroughGeneration: Object.freeze({ major: 0, minor: 45, patch: 0 }),
  }),
  Object.freeze({
    path: Object.freeze(["bash", 'npx -y "github:orobsonn/claude-harness#*" init*']),
    historicalValue: "allow",
    shippedThroughGeneration: Object.freeze({ major: 0, minor: 45, patch: 0 }),
  }),
  Object.freeze({
    path: Object.freeze(["bash", "git pull*"]),
    historicalValue: "allow",
    // predates opencode.json.example (introduced v0.39.0) — no tagged evidence; gate to generation zero only
    shippedThroughGeneration: Object.freeze({ major: 0, minor: 0, patch: 0 }),
  }),
  Object.freeze({
    path: Object.freeze(["bash", "*"]),
    historicalValue: "allow",
    shippedThroughGeneration: Object.freeze({ major: 0, minor: 0, patch: 0 }),
  }),
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function pathKey(path) {
  return JSON.stringify(path);
}

/**
 * @description First non-empty line of a `.harness-version` file's contents.
 * @param {unknown} fileContent
 * @returns {string | null}
 */
export function readHarnessVersionStamp(fileContent) {
  if (typeof fileContent !== "string") return null;
  const firstLine = fileContent.split(/\r?\n/)[0]?.trim();
  return firstLine ? firstLine : null;
}

/**
 * @description Normalizes any of the 3 stamp formats the fleet ships (git-describe with
 * `-N-g<sha>` distance, exact `vX.Y.Z` tag, or a bare SHA pre-dating tags) into a comparable
 * semver-shaped generation. A bare SHA normalizes to generation zero — the oldest baseline.
 * @param {unknown} stamp
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function normalizeOcVersionStamp(stamp) {
  if (typeof stamp !== "string") return null;
  const trimmed = stamp.trim();
  if (!trimmed) return null;

  const describeMatch = trimmed.match(/^(v?\d+\.\d+\.\d+)-\d+-g[0-9a-f]+$/i);
  const base = describeMatch ? describeMatch[1] : trimmed;

  const semverMatch = base.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (semverMatch) {
    return {
      major: parseInt(semverMatch[1], 10),
      minor: parseInt(semverMatch[2], 10),
      patch: parseInt(semverMatch[3], 10),
    };
  }

  return { major: 0, minor: 0, patch: 0 };
}

/**
 * @description Compares two normalized generations numerically.
 * @param {{major:number,minor:number,patch:number}} a
 * @param {{major:number,minor:number,patch:number}} b
 * @returns {-1 | 0 | 1}
 */
function compareGeneration(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * @description Structural shape check run as a validation gate right before the atomic rename —
 * catches a migration that produced something un-writable-as-config before it ever reaches disk.
 * @param {unknown} config
 * @returns {boolean}
 */
export function isValidOpencodeConfigShape(config) {
  if (!isPlainObject(config)) return false;
  if (config.permission !== undefined && !isPlainObject(config.permission)) return false;
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) return false;
  return true;
}

/**
 * Recursively merges one node of the `permission` tree.
 * @param {string[]} path - path from the permission root, e.g. `["bash", "git pull"]`
 * @param {unknown} existingNode - value at `path` in the project's current config
 * @param {unknown} newNode - value at `path` in the new generation's canonical config
 * @param {unknown} ownedNode - value at `path` the manifest recorded as harness-written (tier 1)
 * @param {Map<string, {path: string[], historicalValue: unknown, shippedThroughGeneration: {major:number,minor:number,patch:number}}>} ledgerByPath
 * @param {{major:number,minor:number,patch:number} | null} projectGeneration - normalized stamp of
 *   the project's own last-vendored generation; a ledger match only applies at or before the
 *   entry's `shippedThroughGeneration` (a project newer than that never received it from the harness)
 * @returns {{ value: unknown, owned: unknown, report: Array<Record<string, unknown>> }}
 */
function mergeNode(path, existingNode, newNode, ownedNode, ledgerByPath, projectGeneration) {
  function ledgerMatches(childPath, value) {
    const entry = ledgerByPath.get(pathKey(childPath));
    if (entry === undefined || !deepEqual(value, entry.historicalValue)) return false;
    if (projectGeneration === null) return false;
    return compareGeneration(projectGeneration, entry.shippedThroughGeneration) <= 0;
  }

  // Recurse only when both sides agree the node is a map (or the key is simply new). A type
  // mismatch — an operator scalar like `"bash": "deny"` where the new generation now ships an
  // object map — must NEVER be silently coerced into `{}` and discarded; it falls through to the
  // leaf branch below, which decides via the same owned/ledger check whether it's safe to replace.
  const existingIsMissingOrObject = existingNode === undefined || isPlainObject(existingNode);
  if (isPlainObject(newNode) && existingIsMissingOrObject) {
    const existingObj = isPlainObject(existingNode) ? existingNode : {};
    const ownedObj = isPlainObject(ownedNode) ? ownedNode : {};
    const mergedObj = {};
    const ownedOut = {};
    const report = [];

    for (const key of Object.keys(newNode)) {
      const childPath = [...path, key];
      const result = mergeNode(childPath, existingObj[key], newNode[key], ownedObj[key], ledgerByPath, projectGeneration);
      mergedObj[key] = result.value;
      if (result.owned !== undefined) ownedOut[key] = result.owned;
      report.push(...result.report);
    }

    for (const key of Object.keys(existingObj)) {
      if (Object.hasOwn(newNode, key)) continue;
      const childPath = [...path, key];
      const existingValue = existingObj[key];
      const matchesOwned = Object.hasOwn(ownedObj, key) && deepEqual(existingValue, ownedObj[key]);

      if (matchesOwned || ledgerMatches(childPath, existingValue)) {
        report.push({ path: childPath, action: "removed-retired", value: existingValue });
        continue;
      }
      mergedObj[key] = existingValue;
      report.push({ path: childPath, action: "kept-custom", value: existingValue });
    }

    return { value: mergedObj, owned: ownedOut, report };
  }

  if (existingNode === undefined) {
    return { value: newNode, owned: newNode, report: [{ path, action: "added", value: newNode }] };
  }
  if (deepEqual(existingNode, newNode)) {
    return { value: existingNode, owned: newNode, report: [] };
  }

  const matchesOwned = ownedNode !== undefined && deepEqual(existingNode, ownedNode);

  if (matchesOwned || ledgerMatches(path, existingNode)) {
    return { value: newNode, owned: newNode, report: [{ path, action: "updated", from: existingNode, to: newNode }] };
  }
  return { value: existingNode, owned: undefined, report: [{ path, action: "kept-custom", value: existingNode }] };
}

/**
 * @description Migrates a project's `permission` block from whatever generation it was last
 * vendored at to the current one, without ever discarding an operator customization.
 *
 * Tier is derived from what's available: a manifest (tier 1) gives exact provenance for every
 * harness-owned key; without one, a legible `.harness-version` (tier 2) falls back to the
 * retired-entries ledger; without either, the project is fresh (tier 3) and receives the full
 * new generation's set. All three tiers share one merge so the result is provably idempotent —
 * a second pass converges immediately because every already-migrated leaf already equals the
 * new generation's value.
 *
 * @param {{
 *   existingConfig: Record<string, unknown>,
 *   newConfig: Record<string, unknown>,
 *   manifest: { owned?: Record<string, unknown> } | null,
 *   previousHarnessVersionStamp?: string | null,
 *   newHarnessVersion?: string | null,
 * }} params
 * @returns {{
 *   config: Record<string, unknown>,
 *   manifest: { version: number, harnessVersion: string, owned: Record<string, unknown> },
 *   tier: 1 | 2 | 3,
 *   report: Array<Record<string, unknown>>,
 * }}
 */
export function migrateOpencodeConfig({
  existingConfig,
  newConfig,
  manifest = null,
  previousHarnessVersionStamp = null,
  newHarnessVersion = null,
}) {
  const tier = manifest ? 1 : previousHarnessVersionStamp ? 2 : 3;
  const ledgerByPath = new Map(RETIRED_OC_PERMISSION_ENTRIES.map((entry) => [pathKey(entry.path), entry]));
  const ownedRoot = manifest && isPlainObject(manifest.owned) ? manifest.owned : {};
  const existingPermission = isPlainObject(existingConfig?.permission) ? existingConfig.permission : {};
  const newPermission = isPlainObject(newConfig?.permission) ? newConfig.permission : {};
  const projectGeneration = normalizeOcVersionStamp(previousHarnessVersionStamp ?? manifest?.harnessVersion ?? null);

  const merged = mergeNode([], existingPermission, newPermission, ownedRoot, ledgerByPath, projectGeneration);

  return {
    config: { ...existingConfig, permission: merged.value },
    manifest: {
      version: 1,
      harnessVersion: newHarnessVersion ?? previousHarnessVersionStamp ?? manifest?.harnessVersion ?? "unknown",
      owned: merged.owned,
    },
    tier,
    report: merged.report,
  };
}

export default {
  MANIFEST_FILENAME,
  RETIRED_OC_PERMISSION_ENTRIES,
  readHarnessVersionStamp,
  normalizeOcVersionStamp,
  isValidOpencodeConfigShape,
  migrateOpencodeConfig,
};
