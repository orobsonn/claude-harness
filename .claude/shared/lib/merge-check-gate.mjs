/**
 * @description Pure, fail-closed policy for the small set of official harness PR merges.
 * It intentionally has no cache, polling, GitHub client, or persistence: adapters fetch one
 * exact PR rollup immediately before their merge attempt and feed it here.
 */

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const EVIDENCE_GREEN = new Set(["SUCCESS", "NEUTRAL"]);
const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "REQUESTED", "WAITING"]);
const RED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "ERROR", "FAIL"]);

/**
 * @param {unknown} rollup GitHub `statusCheckRollup` array, or null when it cannot be read.
 * @returns {{ok: true, state: "green"}|{ok: false, state: "missing"|"pending"|"red"|"unavailable", reason: string}}
 */
export function decideMergeChecks(rollup) {
  if (!Array.isArray(rollup)) {
    return { ok: false, state: "unavailable", reason: "CI could not be read; merge is denied." };
  }
  if (rollup.length === 0) {
    return { ok: false, state: "missing", reason: "No CI checks are reported; merge is denied." };
  }
  let pending = false;
  let hasExecutedGreen = false;
  for (const check of rollup) {
    const raw = typeof check === "object" && check !== null ? check : {};
    const state = String(raw.conclusion ?? raw.state ?? raw.status ?? "").toUpperCase();
    if (GREEN.has(state)) {
      if (EVIDENCE_GREEN.has(state)) hasExecutedGreen = true;
      continue;
    }
    if (PENDING.has(state)) {
      pending = true;
      continue;
    }
    if (RED.has(state)) {
      return { ok: false, state: "red", reason: "At least one CI check is failing; merge is denied." };
    }
    return { ok: false, state: "unavailable", reason: "CI has an unknown conclusion; merge is denied." };
  }
  if (pending) {
    return { ok: false, state: "pending", reason: "CI is still running; merge is denied." };
  }
  if (!hasExecutedGreen) {
    return { ok: false, state: "missing", reason: "No CI check completed successfully; merge is denied." };
  }
  return { ok: true, state: "green" };
}

/**
 * @description Gets one literal PR target from a simple `gh pr merge` command. `null` means the
 * current branch; `undefined` is ambiguous/unsafe and must be denied instead of guessed.
 * @param {unknown} command
 * @returns {string|null|undefined}
 */
export function mergeTargetFromCommand(command) {
  if (typeof command !== "string") return undefined;
  const mergeParts = command.split(/(?:&&|\|\||;)/).filter((candidate) => /\bgh\s+pr\s+merge\b/.test(candidate));
  if (mergeParts.length !== 1) return undefined;
  const part = mergeParts[0];
  if (!part || /["'`$\\()]/.test(part)) return undefined;
  const match = /\bgh\s+pr\s+merge\b([\s\S]*)/.exec(part);
  if (!match) return undefined;
  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  const takesValue = new Set(["--match-head-commit", "--subject", "--body", "--body-file"]);
  const booleanFlag = new Set(["--admin", "--disable-auto", "--delete-branch", "--merge", "--rebase", "--squash"]);
  const targets = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (takesValue.has(token)) {
      if (!tokens[++i]) return undefined;
      continue;
    }
    // A hook/agent reader is scoped to its working repository. Do not inspect one repository and
    // merge another through `--repo`; reject it until an explicit cross-repo boundary exists.
    if (token === "--repo" || token.startsWith("--repo=")) return undefined;
    // Auto-merge schedules a future merge after this one-shot observation; it is outside this
    // immediate gate and must be denied rather than creating a watcher/state machine.
    if (token === "--auto") return undefined;
    if (booleanFlag.has(token) || /^--match-head-commit=\S+$/.test(token)) continue;
    if (token.startsWith("-")) return undefined;
    targets.push(token);
  }
  if (targets.length === 0) return null;
  if (targets.length !== 1) return undefined;
  return /^\d+$/.test(targets[0]) || /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(targets[0])
    ? targets[0]
    : undefined;
}

/** @param {unknown} command @returns {boolean} */
export function isGhPrMergeCommand(command) {
  return typeof command === "string" && command.split(/(?:&&|\|\||;)/).some((part) => /\bgh\s+pr\s+merge\b/.test(part));
}
