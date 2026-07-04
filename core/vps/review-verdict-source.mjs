/**
 * @description Fresh-verdict source for the independent PR-review phase. The ONLY trusted
 * source of a merge verdict is the engine-controlled artifact written under stateDir by the
 * spawned review session at join(stateDir, `review-<pr>-<sha>.json`). The embedded
 * `<!--harness:verdict-->` block inside the (editable) PR body is NEVER read from this
 * module — parseVerdictBlock is never called here. A missing artifact returns null, which
 * must block merge rather than silently falling back to the embedded verdict block.
 * An artifact placed inside the PR's own worktree (not stateDir) is ignored.
 *
 * HR-5 / #ac-2.1 + #ac-3.3
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @description Reads the fresh review verdict for a PR at a given head SHA from the
 * engine-controlled artifact under stateDir. The artifact path is
 * join(stateDir, `review-<pr.number>-<sha>.json`). The PR body (pr.body) is accepted
 * only so callers can pass the full PR object through, but it is NEVER read —
 * parseVerdictBlock is never called from this module. A missing or unparsable artifact
 * returns null (blocks merge), never falls back to the embedded verdict block.
 * @param {{number: number, body?: string}} pr — PR object; only pr.number is used to
 *   select the artifact file; pr.body is never read
 * @param {string} sha — head SHA the review was run against
 * @param {string} stateDir — engine-controlled state directory
 * @returns {{status: 'CLEAN'|'BLOCKED', finding?: string}|null} the parsed verdict, or
 *   null when no artifact exists at the expected path
 */
export function getFreshVerdict(pr, sha, stateDir) {
  const artifactPath = join(stateDir, `review-${pr.number}-${sha}.json`);

  let raw;
  try {
    raw = readFileSync(artifactPath, "utf8");
  } catch {
    // ENOENT or any other read failure — no artifact means no verdict.
    // Never fall back to the embedded PR-body block.
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt artifact — treat as missing (blocks merge).
    return null;
  }
}
