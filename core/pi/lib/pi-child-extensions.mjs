import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const CHILD_EXTENSION_NAMES = Object.freeze([
  "harness-policy.ts",
  "harness-entry-gate.ts",
  "harness-plan-write-gate.ts",
]);

function harnessLayout(root) {
  const packageRoot = resolve(root);
  const sourcePi = join(packageRoot, "core/pi");
  if (existsSync(join(sourcePi, "extensions"))) {
    return {
      piRoot: sourcePi,
      skillRoots: [join(packageRoot, "core/codex/skills"), join(sourcePi, "skills")],
    };
  }
  return { piRoot: packageRoot, skillRoots: [join(packageRoot, "skills")] };
}

function canonical(path) {
  try { return realpathSync(path); }
  catch { return null; }
}

function skillFiles(root) {
  const found = [];
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...skillFiles(path));
    else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
  }
  return found;
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resources inherited by child loaders; the parent keeps its explicit CLI lists. */
export function piChildResourceSettings(root) {
  const layout = harnessLayout(root);
  return {
    extensions: CHILD_EXTENSION_NAMES.map((name) => join(layout.piRoot, "extensions", name)),
    skills: layout.skillRoots,
  };
}

/**
 * Strict synchronous admission check for the loader snapshot emitted by the
 * sealed pi-subagents lifecycle seam. Extra native/package resources are
 * allowed; every mandatory harness rail and skill must be present by real path.
 */
export function verifyPiChildBoundResources(root, payload) {
  const required = piChildResourceSettings(root);
  const extensionErrors = Array.isArray(payload?.extensions?.errors) ? payload.extensions.errors : [];
  if (extensionErrors.length > 0) {
    const first = extensionErrors[0];
    return { ok: false, reason: `child extension failed: ${String(first?.error ?? first)}` };
  }
  const loadedExtensions = new Set(
    (Array.isArray(payload?.extensions?.resolvedPaths) ? payload.extensions.resolvedPaths : [])
      .map(canonical)
      .filter(Boolean),
  );
  for (const expected of required.extensions) {
    const identity = canonical(expected);
    if (!identity || !loadedExtensions.has(identity)) {
      return { ok: false, reason: `child extension missing: ${expected}` };
    }
  }

  const skillDiagnostics = Array.isArray(payload?.skills?.diagnostics) ? payload.skills.diagnostics : [];
  const skillError = skillDiagnostics.find((diagnostic) => diagnostic?.type === "error");
  if (skillError) return { ok: false, reason: `child skill failed: ${String(skillError.message ?? skillError)}` };
  const loadedSkills = new Set(
    (Array.isArray(payload?.skills?.filePaths) ? payload.skills.filePaths : [])
      .map(canonical)
      .filter(Boolean),
  );
  for (const rootPath of required.skills) {
    const canonicalRoot = canonical(rootPath);
    if (!canonicalRoot) return { ok: false, reason: `child skill root missing: ${rootPath}` };
    for (const expected of skillFiles(canonicalRoot)) {
      const identity = canonical(expected);
      if (!identity || !isWithin(canonicalRoot, identity) || !loadedSkills.has(identity)) {
        return { ok: false, reason: `child skill missing: ${expected}` };
      }
    }
  }
  return { ok: true };
}

export const PI_CHILD_EXTENSION_NAMES = CHILD_EXTENSION_NAMES;
