/** Capture the immutable code/assets used to launch a delegated Pi task. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const fail = (reason) => ({
  ok: false,
  reason: `task runtime assets: ${reason}`,
});
const excluded = (relative) => {
  const parts = relative.split("/");
  const lower = parts.map((part) => part.toLowerCase());
  const name = lower.at(-1);
  return (
    parts.includes("node_modules") ||
    parts.includes(".git") ||
    parts.includes("__tests__") ||
    parts.includes("tests") ||
    /\.(?:test|spec)\.[^.]+$/.test(name) ||
    lower.some(
      (part) =>
        /^\.?(?:credentials?|secrets?)$/.test(part) ||
        [".ssh", ".aws"].includes(part),
    ) ||
    /(?:^|\/)\.pi\/harness\/(?:runtime|state|sessions)(?:\/|$)/i.test(
      relative,
    ) ||
    name === "auth.json" ||
    /^\.env(?:\.|$)/.test(name) ||
    /^\.dev\.vars/.test(name) ||
    /^(?:credentials|secrets)\.json$/.test(name) ||
    /^\.(?:npmrc|netrc|pypirc|git-?credentials)$/.test(name)
  );
};

function layout(launcher) {
  const piRoot = path.dirname(path.dirname(launcher));
  if (
    path.basename(piRoot) === "pi" &&
    path.basename(path.dirname(piRoot)) === "core"
  ) {
    const repo = path.dirname(path.dirname(piRoot));
    return {
      base: repo,
      roots: ["core/pi", "core/shared", "core/codex", "core/opencode", "core/claude-code/skills/creating-plans/references/complexity-scorer.mjs"],
    };
  }
  if (
    path.basename(piRoot) === "harness" &&
    path.basename(path.dirname(piRoot)) === ".pi"
  ) {
    return {
      base: piRoot,
      roots: [
        "bin",
        "extensions",
        "lib",
        "prompts",
        "skills",
        "vendor",
        "runtime-defaults",
        "runtime-deps",
      ],
    };
  }
  throw new Error(
    "launcher is not in a supported source or vendored Pi layout",
  );
}

function filesUnder(base, roots) {
  const files = [];
  const visit = (absolute) => {
    const relative = path.relative(base, absolute).split(path.sep).join("/");
    if (excluded(relative)) return;
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink())
      throw new Error(`managed asset is a symlink: ${relative}`);
    if (info.isDirectory())
      for (const name of fs.readdirSync(absolute).sort())
        visit(path.join(absolute, name));
    else if (info.isFile()) files.push({ absolute, relative });
    else throw new Error(`managed asset is not a regular file: ${relative}`);
  };
  for (const root of roots) {
    const absolute = path.join(base, ...root.split("/"));
    if (!fs.existsSync(absolute))
      throw new Error(`managed asset root is missing: ${root}`);
    visit(absolute);
  }
  return files.sort((a, b) =>
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
  );
}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const canonicalFile = (file) =>
  fs.realpathSync(file) === path.resolve(file) && fs.lstatSync(file).isFile();

/** Resolve a runtime separately from product files when the harness develops itself. */
export function resolveTaskRuntimeLauncher({
  parentRoot,
  worktree,
  runtimeRoot,
  baseSha,
  sourceLauncher,
} = {}) {
  try {
    const parent = fs.realpathSync(parentRoot);
    const sourceInput = path.resolve(sourceLauncher);
    const source = fs.realpathSync(sourceInput);
    if (
      parent !== path.resolve(parentRoot) ||
      source !== sourceInput ||
      !canonicalFile(source) ||
      !COMMIT.test(baseSha ?? "")
    )
      throw new Error(
        "canonical roots, launcher and 40-character base SHA required",
      );
    const relative = inside(parent, source)
      ? path.relative(parent, source).split(path.sep).join("/")
      : null;
    if (relative === ".pi/harness/bin/pi-harness.mjs") {
      const child = fs.realpathSync(worktree);
      if (child !== path.resolve(worktree))
        throw new Error("task worktree must be canonical");
      const launcher = path.join(child, ...relative.split("/"));
      git(child, "merge-base", "--is-ancestor", baseSha, "HEAD");
      if (!canonicalFile(launcher))
        throw new Error("vendored child launcher is missing or non-canonical");
      return { ok: true, launcherPath: launcher };
    }
    if (relative === "core/pi/bin/pi-harness.mjs") {
      const root = path.resolve(runtimeRoot);
      if (!inside(parent, root))
        throw new Error(
          "runtime checkout root must stay inside the parent project",
        );
      fs.mkdirSync(root, { recursive: true });
      if (fs.realpathSync(root) !== root)
        throw new Error("runtime checkout root must be canonical");
      const checkout = path.join(root, baseSha);
      if (!fs.existsSync(checkout))
        git(parent, "worktree", "add", "--detach", checkout, baseSha);
      const canonical = fs.realpathSync(checkout);
      const launcher = path.join(canonical, ...relative.split("/"));
      const common = (cwd) =>
        fs.realpathSync(
          path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")),
        );
      if (
        canonical !== path.resolve(checkout) ||
        git(canonical, "rev-parse", "HEAD") !== baseSha ||
        git(canonical, "branch", "--show-current") ||
        common(canonical) !== common(parent) ||
        git(canonical, "status", "--porcelain", "--untracked-files=all") ||
        !canonicalFile(launcher)
      )
        throw new Error(
          "runtime checkout does not match the clean reserved source base",
        );
      return { ok: true, launcherPath: launcher };
    }
    if (inside(parent, source))
      throw new Error("project-local launcher has an unsupported layout");
    return { ok: true, launcherPath: source };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function captureTaskRuntime(launcherPath) {
  try {
    const launcher = path.resolve(launcherPath ?? "");
    if (
      !launcherPath ||
      fs.realpathSync(launcher) !== launcher ||
      !fs.lstatSync(launcher).isFile()
    )
      throw new Error("launcher must be a canonical regular file");
    const found = layout(launcher);
    const digest = createHash("sha256");
    for (const file of filesUnder(found.base, found.roots)) {
      const bytes = fs.readFileSync(file.absolute);
      digest.update(`file\0${file.relative}\0${bytes.length}\0`);
      digest.update(bytes);
      digest.update("\0");
    }
    return {
      ok: true,
      runtime: { launcher_path: launcher, sha256: digest.digest("hex") },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function verifyTaskRuntime(runtime) {
  if (
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    typeof runtime.launcher_path !== "string" ||
    !SHA256.test(runtime.sha256 ?? "")
  )
    return fail("invalid runtime receipt");
  const current = captureTaskRuntime(runtime.launcher_path);
  if (!current.ok) return current;
  return current.runtime.sha256 === runtime.sha256
    ? { ok: true, runtime: current.runtime }
    : fail("managed assets changed since task admission");
}

export default {
  captureTaskRuntime,
  verifyTaskRuntime,
  resolveTaskRuntimeLauncher,
};
