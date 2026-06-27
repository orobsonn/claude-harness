/**
 * @description Dependency-free CI generator that emits a project-specific
 * .github/workflows/ci.yml YAML string. Receives a pre-computed stack and secrets
 * (do NOT re-detect inside this module). Produces two jobs when secrets are non-empty:
 *
 *   Job 1 (always required, id === jobName): runs the stack command with NO secret
 *   references. This becomes the required status-check context — it must never depend
 *   on a secret so it never blocks Dependabot or other automated PRs.
 *
 *   Job 2 (only when secrets is non-empty): gated by the same-repo condition so
 *   fork/Dependabot PRs SKIP it (skipped = neutral, not failed). Wires each secret
 *   as ${{ secrets.NAME }} in the step env block.
 *
 * SECURITY INVARIANTS enforced here:
 *   - Trigger is plain `pull_request` — NEVER `pull_request_target` (which runs in
 *     the base-repo context with secrets and can be tricked into checking out fork
 *     code, enabling secret exfiltration).
 *   - The `if:` on the secret job is the exact same-repo condition; any weaker
 *     condition could expose secrets to untrusted fork code.
 *   - Job 1 never receives any `${{ secrets.* }}` reference, keeping the required
 *     gate independent of secret availability.
 *
 * Uses Node builtins only — no external YAML library.
 *
 * @module generate-ci
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectStack } from "./detect-stack.mjs";
import { detectRequiredSecrets } from "./detect-secrets.mjs";

/**
 * @description Generates a GitHub Actions CI workflow YAML string for a given
 * project stack and set of required secret names.
 *
 * @param {{ stack: { runner: string|null, command: string|null, status: string }, secrets: string[], nodeVersion?: string, jobName?: string }} params
 * @param {object} params.stack - Pre-computed stack object from detectStack (do NOT re-detect here).
 * @param {string[]} params.secrets - Pre-computed list of required secret names from detectRequiredSecrets.
 * @param {string} [params.nodeVersion="22"] - Exact Node.js version string to pin.
 * @param {string} [params.jobName="test"] - The job id for the always-required status-check job.
 * @returns {string} YAML content for the CI workflow.
 */
export function generateCi({
  stack,
  secrets = [],
  nodeVersion = "22",
  jobName = "test",
}) {
  // Fix 3: null/empty command guard
  if (!stack || typeof stack.command !== "string" || stack.command.trim() === "") {
    throw new Error("generateCi requires a non-empty stack.command");
  }

  // Fix 1: reserved job-name collision guard
  if (jobName === "check-env") {
    throw new Error('jobName cannot be "check-env" (reserved for the secret job)');
  }

  // Fix 2: allowlist validation — prevents YAML injection
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(jobName)) {
    throw new Error("jobName must match /^[A-Za-z_][A-Za-z0-9_-]*$/");
  }
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(nodeVersion)) {
    throw new Error("nodeVersion must match /^[0-9]+(\\.[0-9]+){0,2}$/");
  }
  for (const secret of secrets) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      throw new Error(`Secret name "${secret}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
  }
  if (new Set(secrets).size !== secrets.length) {
    throw new Error("secrets must not contain duplicates");
  }

  // YAML injection defense-in-depth: a newline or control char in the command
  // would break the `- run:` scalar and inject arbitrary YAML nodes.
  if (/[\n\r\x00-\x1f]/.test(stack.command)) {
    throw new Error(
      "stack.command must not contain newline or control characters (YAML-injection guard)"
    );
  }

  const lines = [];

  lines.push("name: CI");
  lines.push("");
  // SECURITY: plain pull_request — never pull_request_target
  lines.push("on:");
  lines.push("  pull_request:");
  lines.push("    branches:");
  lines.push("      - main");
  // No paths: filter — runs on every PR against main regardless of changed files
  lines.push("");
  // Fix 4: least-privilege — read-only default permission
  lines.push("permissions:");
  lines.push("  contents: read");
  lines.push("");
  lines.push("jobs:");

  // Job 1 — always required, secret-free
  // This job id becomes the required status-check context in branch protection.
  // It must never depend on secrets so it always runs on Dependabot and fork PRs.
  lines.push(`  ${jobName}:`);
  lines.push("    runs-on: ubuntu-latest");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("      - uses: actions/setup-node@v4");
  lines.push("        with:");
  lines.push(`          node-version: "${nodeVersion}"`);
  lines.push(`      - run: ${stack.command}`);

  // Job 2 — only emitted when the project declares required secrets
  // Gated by the same-repo condition: fork/Dependabot PRs skip this job entirely
  // (GitHub treats skipped as neutral/success, so it never blocks dependency PRs).
  if (secrets.length > 0) {
    lines.push("");
    lines.push("  check-env:");
    lines.push("    runs-on: ubuntu-latest");
    // SECURITY: exact same-repo condition — must not be weakened (e.g. no wildcard,
    // no actor-based check). This is the only condition that reliably prevents
    // fork-submitted code from accessing repository secrets via pull_request.
    lines.push(
      "    if: github.event.pull_request.head.repo.full_name == github.repository"
    );
    lines.push("    steps:");
    lines.push("      - uses: actions/checkout@v4");
    lines.push("      - uses: actions/setup-node@v4");
    lines.push("        with:");
    lines.push(`          node-version: "${nodeVersion}"`);
    lines.push(`      - run: ${stack.command}`);
    lines.push("        env:");
    for (const secret of secrets) {
      // \${{ is literal ${{ in the output — the backslash escapes the dollar from
      // being a JavaScript template-expression opener while ${secret} interpolates.
      lines.push(`          ${secret}: \${{ secrets.${secret} }}`);
    }
  }

  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly: detect stack + secrets, generate ci.yml, write non-clobber.
// Usage: node generate-ci.mjs [--target <project-dir>] [--job-name <name>] [--node-version <ver>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = process.cwd();
  let jobName = "test";
  let nodeVersion = "22";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1] !== undefined) {
      target = args[++i];
    } else if (args[i] === "--job-name" && args[i + 1] !== undefined) {
      jobName = args[++i];
    } else if (args[i] === "--node-version" && args[i + 1] !== undefined) {
      nodeVersion = args[++i];
    }
  }

  // Validate target is an existing directory (path-traversal hardening)
  const resolvedTarget = resolve(target);
  try {
    const stat = statSync(resolvedTarget);
    if (!stat.isDirectory()) {
      process.stderr.write(`[generate-ci] Error: target must be a directory: ${resolvedTarget}\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`[generate-ci] Error: target directory not found: ${resolvedTarget}\n`);
    process.exit(1);
  }
  target = resolvedTarget;

  const stack = detectStack(target);

  if (stack.status === "skip") {
    process.stdout.write(`[generate-ci] Skipped: ${stack.reason}\n`);
    process.exit(0);
  }

  const { secrets, setupGuide } = detectRequiredSecrets(target);

  let yaml;
  try {
    yaml = generateCi({ stack, secrets, nodeVersion, jobName });
  } catch (err) {
    process.stderr.write(`[generate-ci] Error generating CI: ${err.message}\n`);
    process.exit(1);
  }

  const ciDir = join(target, ".github", "workflows");
  const ciPath = join(ciDir, "ci.yml");

  if (existsSync(ciPath)) {
    process.stdout.write(`[generate-ci] Skipped (exists): ${ciPath}\n`);
  } else {
    mkdirSync(ciDir, { recursive: true });
    writeFileSync(ciPath, yaml, "utf8");
    process.stdout.write(`[generate-ci] Written: ${ciPath}\n`);
  }

  if (setupGuide) {
    process.stdout.write(`\nSecret setup guide:\n${setupGuide}\n`);
  }
}
