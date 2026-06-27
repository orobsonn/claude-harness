/**
 * @description Dependency-free branch-protection helper that updates GitHub branch
 * protection via GET-then-merge — never a blind PUT that clobbers existing settings.
 *
 * Exports two functions:
 *   - buildProtectionPayload: merges existing protection with managed fields.
 *   - applyProtection: GET-then-merge-then-PUT, guarded by hasAdminToken.
 *
 * INVARIANTS enforced here:
 *   - enforce_admins is ALWAYS false (never accidentally true after merge).
 *   - required_pull_request_reviews is ALWAYS null (no approval gate required).
 *   - required_status_checks.contexts = existing contexts UNION [requiredContext] (dedupe).
 *   - Unmanaged fields from existing protection are preserved (no clobber).
 *   - When hasAdminToken is false, putProtection is NEVER called.
 *
 * Uses Node builtins only — no external dependencies. No network calls; callers inject
 * getProtection/putProtection (testable via mocks).
 *
 * @module branch-protection
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * @description Builds a merged branch-protection PUT payload from the existing
 * protection object. Preserves all unmanaged fields, enforces the required
 * status-check context (union, dedupe), and applies the managed invariants.
 *
 * @param {object} existingProtection - The object returned by the GitHub API GET
 *   branch protection endpoint. May contain required_status_checks, enforce_admins,
 *   required_pull_request_reviews, restrictions, and other fields.
 * @param {{ requiredContext: string }} options
 * @param {string} options.requiredContext - The CI job name to add to the required
 *   status-check contexts (must match the job id from generateCi exactly).
 * @returns {object} A merged payload safe to PUT to the GitHub branch-protection API.
 */
export function buildProtectionPayload(existingProtection, { requiredContext }) {
  if (typeof requiredContext !== "string" || requiredContext.trim() === "") {
    throw new Error(
      "requiredContext must be a non-empty status-check job id"
    );
  }

  // Build the contexts union: existing (if any) UNION [requiredContext], deduped.
  const existingContexts =
    Array.isArray(existingProtection?.required_status_checks?.contexts)
      ? existingProtection.required_status_checks.contexts
      : [];

  const normalizedContext = requiredContext.trim();
  const contextsSet = new Set(existingContexts);
  contextsSet.add(normalizedContext);

  // Build the PUT body from an EXPLICIT whitelist mapped to PUT shapes — never
  // spread the GET response (GET schema ≠ PUT schema). Dropping checks/url/
  // contexts_url here is what prevents GitHub from honoring the stale `checks`
  // array over `contexts` and silently dropping the new required context.
  const merged = {
    required_status_checks: {
      strict: existingProtection?.required_status_checks?.strict ?? true,
      contexts: Array.from(contextsSet),
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: (() => {
      const restrictions = existingProtection?.restrictions;
      if (restrictions == null) return null;
      return {
        users: (restrictions.users ?? []).map((u) => u.login ?? u),
        teams: (restrictions.teams ?? []).map((t) => t.slug ?? t),
        apps: (restrictions.apps ?? []).map((a) => a.slug ?? a),
      };
    })(),
  };

  // Preserve known boolean toggles ONLY if present, mapping GitHub's {enabled}
  // object shape to a plain boolean. required_signatures is intentionally NOT
  // carried (it lives behind a separate endpoint).
  const booleanToggles = [
    "required_linear_history",
    "allow_force_pushes",
    "allow_deletions",
    "required_conversation_resolution",
    "lock_branch",
    "block_creations",
    "allow_fork_syncing",
  ];
  for (const field of booleanToggles) {
    const value = existingProtection?.[field];
    if (value != null) {
      merged[field] = Boolean(value.enabled ?? value);
    }
  }

  return merged;
}

/**
 * @description Applies branch protection using a GET-then-merge strategy.
 * When hasAdminToken is false, returns immediately without calling putProtection.
 * When true, GETs existing protection, builds the merged payload via
 * buildProtectionPayload, and calls putProtection with it.
 *
 * @param {{ getProtection: Function, putProtection: Function, hasAdminToken: boolean, requiredContext: string }} params
 * @param {() => Promise<object|null>} params.getProtection - Async function that returns
 *   the current branch protection object (injected; no real network call here).
 *   Should resolve null on a 404 (no existing protection); applyProtection also
 *   handles a thrown error with status 404 or a message containing "404".
 * @param {(payload: object) => Promise<void>} params.putProtection - Async function
 *   that applies the new protection payload (injected; only called when hasAdminToken
 *   is true).
 * @param {boolean} params.hasAdminToken - Whether an admin token is available. When
 *   false, putProtection is NEVER called and { applied: false, reason } is returned.
 * @param {string} params.requiredContext - The CI job name to ensure is in the
 *   required status-check contexts.
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
export async function applyProtection({
  getProtection,
  putProtection,
  hasAdminToken,
  requiredContext,
}) {
  if (!hasAdminToken) {
    return {
      applied: false,
      reason:
        "Branch protection not applied: no admin token available. " +
        "Provide a token with admin:repo scope to apply branch protection.",
    };
  }

  let existingProtection;
  try {
    existingProtection = await getProtection();
  } catch (err) {
    if (err?.status === 404 || /404/.test(String(err?.message))) {
      existingProtection = null;
    } else {
      throw err;
    }
  }
  const payload = buildProtectionPayload(existingProtection, { requiredContext });
  await putProtection(payload);

  return { applied: true, payload };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly: DRY-RUN by default (prints payload, no PUT).
// Use --apply to perform the actual PUT (operator-gated).
//
// Usage:
//   node branch-protection.mjs --repo <owner/name> --branch <main>
//     --required-context <jobName> [--apply]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let repo = null;
  let branch = "main";
  let requiredContext = null;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1] !== undefined) {
      repo = args[++i];
    } else if (args[i] === "--branch" && args[i + 1] !== undefined) {
      branch = args[++i];
    } else if (args[i] === "--required-context" && args[i + 1] !== undefined) {
      requiredContext = args[++i];
    } else if (args[i] === "--apply") {
      apply = true;
    }
  }

  if (!repo) {
    process.stderr.write("[branch-protection] Error: --repo <owner/name> is required\n");
    process.exit(1);
  }
  if (!requiredContext) {
    process.stderr.write("[branch-protection] Error: --required-context <jobName> is required\n");
    process.exit(1);
  }

  if (!apply) {
    // DRY-RUN: build a theoretical payload (from null existing protection) and print it.
    // No network calls — the autonomous pipeline always runs without --apply.
    const payload = buildProtectionPayload(null, { requiredContext });
    process.stdout.write("[branch-protection] [dry-run] Would PUT branch protection payload:\n");
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.stdout.write(
      "[branch-protection] [dry-run] Use --apply to apply (operator-gated).\n"
    );
    process.exit(0);
  }

  // APPLY mode — requires admin token and live gh CLI
  const apiPath = `repos/${repo}/branches/${branch}/protection`;

  async function getProtection() {
    try {
      const out = execFileSync("gh", ["api", apiPath], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return JSON.parse(out);
    } catch (err) {
      const msg = String(err?.stderr ?? err?.message ?? "");
      if (/404|Branch not protected|Not Found/.test(msg)) return null;
      throw err;
    }
  }

  async function putProtection(payload) {
    const input = JSON.stringify(payload);
    execFileSync("gh", ["api", apiPath, "--method", "PUT", "--input", "-"], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // Determine hasAdminToken: check if gh CLI is available and authenticated.
  let hasAdminToken = false;
  try {
    execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // authenticated != admin-scoped; GitHub enforces admin scope at PUT (403 → fail-closed)
    hasAdminToken = true;
  } catch {
    hasAdminToken = false;
  }

  if (!hasAdminToken) {
    process.stdout.write(
      JSON.stringify({
        applied: false,
        reason:
          "Branch protection not applied: no admin token available. " +
          "Provide a token with admin:repo scope to apply branch protection.",
      }) + "\n"
    );
    process.exit(0);
  }

  (async () => {
    try {
      const result = await applyProtection({
        getProtection,
        putProtection,
        hasAdminToken,
        requiredContext,
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (err) {
      process.stderr.write(`[branch-protection] Error: ${err.message}\n`);
      process.exit(1);
    }
  })();
}
