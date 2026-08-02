/** @description Migrates a vendored project's opencode.json permission block across harness generations. */

/** @description Sidecar filename (lives under `.opencode/`) tracking harness-owned permission keys. */
export const MANIFEST_FILENAME = ".harness-config-manifest.json";

/**
 * Ledger of retired `permission.*` entries. A project's current value for `path` is safe to
 * drop (or force-upgrade to the new generation's value) when it still EQUALS `historicalValue`
 * (the operator never touched it) AND the project has harness provenance. An entry may be
 * `tier2Only` when a tier-1 manifest can distinguish an owned default from an identical operator
 * choice; those entries use the ledger only when no manifest exists.
 *
 * Retirement is deliberately NOT gated by which generation that stamp shows (issue #513): the
 * original design additionally required the project's generation to be at or before the
 * entry's last-shipped generation, on the premise that "a project vendored after that point
 * could never have received it from the harness, so an identical key+value there must be the
 * operator's own doing." That premise is false for the real population — a project seeded
 * BEFORE an entry's retirement and re-vendored AFTER it (while the migration engine itself
 * still didn't exist, #503) carries the legacy key alongside a version stamp that already
 * cleared the cutoff, and a generation-gated ledger leaves it stuck forever. Content match is
 * the sole discriminator once provenance is established; a project with ZERO provenance (never
 * vendored by the harness — no manifest, no stamp) is the one case where a coincidentally
 * matching value can only be the operator's own doing, and that case alone survives untouched.
 */
export const RETIRED_OC_PERMISSION_ENTRIES = Object.freeze([
  Object.freeze({
    path: Object.freeze(["bash", "node .opencode/plugin/lib/mark-gate.mjs *"]),
    historicalValue: "allow",
  }),
  Object.freeze({
    path: Object.freeze(["bash", "node core/opencode/plugin/lib/mark-gate.mjs *"]),
    historicalValue: "allow",
  }),
  Object.freeze({
    path: Object.freeze(["bash", "npx github:orobsonn/claude-harness#* init*"]),
    historicalValue: "allow",
    // last shipped in v0.45.0 (core/opencode/opencode.json.example); replaced by the pinned #v* set in v0.45.1 (#359)
  }),
  Object.freeze({
    path: Object.freeze(["bash", "npx -y github:orobsonn/claude-harness#* init*"]),
    historicalValue: "allow",
    // last shipped in v0.45.0; replaced by the pinned #v* set in v0.45.1 (#359)
  }),
  Object.freeze({
    path: Object.freeze(["bash", 'npx -y "github:orobsonn/claude-harness#*" init*']),
    historicalValue: "allow",
    // last shipped in v0.45.0; replaced by the pinned #v* set in v0.45.1 (#359)
  }),
  Object.freeze({
    path: Object.freeze(["edit"]),
    historicalValue: "allow",
    // Historical OC generations shipped a blanket scalar. Upgrade the exact harness default to
    // the current pattern map so state-path and secret denies reach already-vendored projects.
  }),
  Object.freeze({
    path: Object.freeze(["read"]),
    historicalValue: "allow",
    // Same scalar-to-map transition as edit. Divergent operator values remain custom.
  }),
  Object.freeze({
    path: Object.freeze(["bash", "*"]),
    historicalValue: "ask",
    tier2Only: true,
    // the prompt-everything catch-all shipped before Auto Mode. Provenanced projects that still
    // carry it are upgraded to the current allow-by-default generation; an operator-diverged
    // value remains protected by the normal content/manifest checks.
  }),
]);
// `["bash", "git pull*"]` was DELIBERATELY left out of this ledger (adversarial finding on #513):
// its own removed comment admitted "predates opencode.json.example — no tagged evidence of when it
// stopped shipping", and the harness's shipped default has always been the narrower `"git pull"`
// (no wildcard) — `git pull*` is exactly the form an operator would author by hand to cover
// `git pull origin main` / `git pull --rebase`. With content-based retirement (no generation gate),
// keeping this low-confidence entry would silently strip a plausible operator customization from
// every provenanced project; without real evidence it was ever a harness default, it does not
// belong in a ledger whose entire premise is "prove the harness authored this."

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
 * @param {Map<string, {path: string[], historicalValue: unknown, tier2Only?: boolean}>} ledgerByPath
 * @param {boolean} hasHarnessProvenance - whether the harness has EVER vendored this project (a
 *   manifest or a legible `.harness-version` stamp) — a ledger content match only applies when
 *   this holds; a project with no provenance keeps a coincidentally matching value untouched,
 *   since there it can only be the operator's own doing (issue #513)
 * @param {1 | 2 | 3} tier
 * @returns {{ value: unknown, owned: unknown, report: Array<Record<string, unknown>> }}
 */
function mergeNode(path, existingNode, newNode, ownedNode, ledgerByPath, hasHarnessProvenance, tier) {
  function ledgerMatches(childPath, value) {
    if (!hasHarnessProvenance) return false;
    const entry = ledgerByPath.get(pathKey(childPath));
    if (entry === undefined) return false;
    if (entry.tier2Only === true && tier !== 2) return false;
    return deepEqual(value, entry.historicalValue);
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
      const result = mergeNode(childPath, existingObj[key], newNode[key], ownedObj[key], ledgerByPath, hasHarnessProvenance, tier);
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
 * @description Keep project-owned permission keys while restoring the canonical last-match-wins
 * safety suffix after them. The suffix starts at each canonical map's first deny and includes any
 * later allow carve-outs whose relative order is load-bearing (for example force-with-lease).
 * @param {Record<string, unknown>} mergedPermission
 * @param {Record<string, unknown>} canonicalPermission
 * @returns {Record<string, unknown>}
 */
function reorderCanonicalProtection(mergedPermission, canonicalPermission) {
  const reorderedPermission = { ...mergedPermission };
  for (const section of ["edit", "read", "bash"]) {
    const mergedMap = mergedPermission[section];
    const canonicalMap = canonicalPermission[section];
    if (!isPlainObject(mergedMap) || !isPlainObject(canonicalMap)) continue;
    const canonicalEntries = Object.entries(canonicalMap);
    const firstDeny = canonicalEntries.findIndex(([, value]) => value === "deny");
    if (firstDeny < 0) continue;
    const suffixKeys = canonicalEntries.slice(firstDeny).map(([key]) => key);
    const suffixSet = new Set(suffixKeys);
    const map = {};
    for (const [key, value] of Object.entries(mergedMap)) {
      if (!suffixSet.has(key)) map[key] = value;
    }
    for (const key of suffixKeys) {
      if (Object.hasOwn(mergedMap, key)) map[key] = mergedMap[key];
    }
    reorderedPermission[section] = map;
  }
  return reorderedPermission;
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
  const hasHarnessProvenance = tier !== 3;

  const merged = mergeNode([], existingPermission, newPermission, ownedRoot, ledgerByPath, hasHarnessProvenance, tier);

  const permission = isPlainObject(merged.value)
    ? reorderCanonicalProtection(merged.value, newPermission)
    : merged.value;

  return {
    config: { ...existingConfig, permission },
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
