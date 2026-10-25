/** @description Pi paths and immutable test artifacts for the task pipeline; the host-neutral contract lives in core/shared/lib/task-contract.mjs. */
import path from "node:path";
import { execFileSync } from "node:child_process";

export {
  TASK_PIPELINE_VERSION,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
} from "../../shared/lib/task-contract.mjs";
import {
  TASK_PIPELINE_VERSION,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
} from "../../shared/lib/task-contract.mjs";

export const TASK_RUN_ENV = "PI_HARNESS_TASK_RUN";

export function taskAdmissionPath(projectRoot, attemptId) {
  return path.join(projectRoot, ".pi", "harness", "state", "task-admission", `${attemptId}.json`);
}

export function taskRegistryPath(projectRoot, parentSessionId) {
  return path.join(projectRoot, ".pi", "harness", "state", parentSessionId, "task-runs", "index.json");
}

/** A canonical test is always a file; only declared fixtures may be a tree. */
export function taskFixtureTreeAllowed(task, file) {
  return !(task?.locked_tests ?? []).some(test => test.path === file) &&
    (task?.locked_tests ?? []).some(test => test.fixture_paths?.includes(file));
}

/** Read immutable bytes for a blob or a recursively sealed fixture tree.
 * `git show tree:path` lists names without blob identities and is NOT a freeze.
 * Raw Git tree bytes include modes and child object IDs, recursively binding every
 * binary and nested file. Reference kind prevents tree-to-blob substitutions.
 */
export function readTaskFrozenArtifact(root, revision, file, { allowTree = false, reference = revision } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(reference) ||
      typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\") ||
      file.includes("\0") || file.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("invalid frozen artifact identity");
  const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024,
    timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  const listing = git("ls-tree", "-z", revision, "--", `:(literal)${file}`).toString("utf8").split("\0").filter(Boolean);
  const match = listing.length === 1 && listing[0].match(/^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/);
  if (!match || match[4] !== file ||
      !(match[2] === "blob" && /^100[0-7]{3}$/.test(match[1]) || allowTree && match[2] === "tree" && match[1] === "040000"))
    throw new Error(`canonical frozen file is not a regular blob or declared fixture tree: ${file}`);
  if (git("cat-file", "-t", `${reference}:${file}`).toString("utf8").trim() !== match[2])
    throw new Error(`frozen artifact kind changed: ${file}`);
  if (match[2] === "tree") {
    const children = git("ls-tree", "-r", "-z", revision, "--", `:(literal)${file}`).toString("utf8").split("\0").filter(Boolean);
    if (!children.length || children.some(entry => !/^100[0-7]{3} blob [a-f0-9]{40}\t/.test(entry)))
      throw new Error(`frozen fixture tree contains a non-regular file: ${file}`);
  }
  return git("cat-file", match[2], match[3]);
}

export default {
  TASK_PIPELINE_VERSION,
  TASK_RUN_ENV,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
  taskAdmissionPath,
  taskRegistryPath,
};
