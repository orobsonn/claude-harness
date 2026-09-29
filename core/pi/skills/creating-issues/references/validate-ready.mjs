#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectIssueDependencies } from "../../../../shared/lib/harness-deps.mjs";

export function validateReadyIssue(repo, number, run = execFileSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1)
    throw new Error("use --repo OWNER/REPO --issue N");
  const raw = run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,blockedBy"],
    { encoding: "utf8", timeout: 15000 });
  const issue = JSON.parse(String(raw));
  const declared = inspectIssueDependencies(issue.body);
  if (declared.status === "invalid") throw new Error("dependency metadata missing or malformed");
  const native = issue.blockedBy;
  if (!native || !Number.isInteger(native.totalCount) || !Array.isArray(native.nodes) ||
      native.nodes.length !== native.totalCount) throw new Error("native blockedBy metadata incomplete");
  return { ok: true, dependencies: declared.numbers, native_blockers: native.totalCount };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--repo" || args[2] !== "--issue")
      throw new Error("use --repo OWNER/REPO --issue N");
    process.stdout.write(`${JSON.stringify(validateReadyIssue(args[1], Number(args[3])))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
