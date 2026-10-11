/**
 * @description Host-neutral contract for parallel task pipelines (Pi and Claude Code): canonical
 * receipt JSON/hash, literal scope paths, scope overlap and readable worktree names. Pure Node; no
 * host paths live here — each host keeps its own `.pi/` or `.claude/` layout.
 */
import { createHash } from "node:crypto";
import path from "node:path";

export const TASK_PIPELINE_VERSION = 1;

/** True only for scope syntax that the literal path authority cannot represent. */
export function unsupportedTaskScopePattern(value) {
  return typeof value === "string" && (
    value.includes("*") ||
    value.includes("?") ||
    /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(value)
  );
}

/** Canonical JSON used when a receipt crosses worktrees. */
export function stableTaskJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

export function hashTaskReceipt(value) {
  return createHash("sha256").update(stableTaskJson(value)).digest("hex");
}

/**
 * Every repo path a task may touch or depend on: scope, allowed writes, locked tests and their
 * fixtures. Literal, repo-relative and normalized; "" stands for the whole repository (".").
 * Throws before any effect on globs, absolute paths, backslashes, NUL or `..` components.
 */
export function taskScopeOf(task) {
  const entries = [
    ...task.scope_paths,
    ...(Array.isArray(task.allowed_writes) ? task.allowed_writes : []),
    ...(task.locked_tests ?? []).flatMap((test) => [
      test.path,
      ...(test.fixture_paths ?? []),
    ]),
  ];
  return entries.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry ||
      path.posix.isAbsolute(entry) ||
      entry.includes("\\") ||
      entry.includes("\0") ||
      entry.split("/").includes("..")
    )
      throw new Error("task scope must use safe repo-relative paths");
    if (unsupportedTaskScopePattern(entry))
      throw new Error(
        `task scope ${JSON.stringify(entry)} uses unsupported glob syntax; use an explicit file or directory path`,
      );
    const normalized = path.posix.normalize(entry).replace(/\/$/, "");
    if (normalized === ".") return "";
    return normalized;
  });
}

/** Equal paths or a path-component prefix overlap; the repository root overlaps everything. */
export function taskScopesOverlap(a, b) {
  return taskScopeOf(a).some((left) =>
    taskScopeOf(b).some(
      (right) =>
        !left ||
        !right ||
        left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`),
    ),
  );
}

/** `task-<N>-<slug>`: N is the plan position; slug is up to 3 words / 36 chars of title or description. */
export function taskWorktreeName(task, index) {
  const slug = (value) => String(value ?? "").normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").slice(0, 3).join("-").slice(0, 36).replace(/-+$/g, "");
  const term = slug(task.title || task.description) ||
    slug(String(task.id ?? "").replace(/^task[-_]?\d*[-_]?/i, "")) || "implementacao";
  return `task-${index}-${term}`;
}

/** First of `name`, `name-2`, `name-3`… that `taken(candidate)` rejects; never reuses a taken name. */
export function availableTaskWorktreeName(name, taken) {
  if (!taken(name)) return name;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`no free task worktree name for ${name}`);
}
