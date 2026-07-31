/** @description Parity manifesto CI checker: verifies both runtime targets have required agents, routing, gates, oracle, no token reads; used by parity-manifest.test.mjs and CI. */
import { readFileSync, existsSync, readdirSync, statSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { validateRouting } from "../core/shared/lib/routing-validate.mjs";
import { harnessOcPluginFiles } from "../core/claude-code/skills/initializing-projects/references/vendor-core.mjs";

/**
 * OC-canonical agent files.
 * Single-evaluator eyes (`plan-reviewer`, `adversary`) are required; the six family/openai
 * names stay required as **2-release alias + optional second-eye stubs** (bound plans and
 * Task dispatch still resolve those filenames). Not "instead of" the six names — both.
 */
export const OC_REQUIRED_AGENTS = [
  "build",
  "planner",
  "plan-reviewer",
  "plan-reviewer-family-1",
  "plan-reviewer-family-2",
  "plan-reviewer-openai",
  "adversary",
  "adversary-family-1",
  "adversary-family-2",
  "adversary-openai",
  "compliance",
  "security",
  "executor-low",
  "executor-medium",
  "executor-high",
  "sniper-low",
  "sniper-medium",
  "sniper-high",
  "test-author",
  "harvester",
  "shipper",
];

/** Claude shell uses singular executor/sniper (no build / dual-openai agent files). */
export const CC_REQUIRED_AGENTS = [
  "planner",
  "plan-reviewer",
  "adversary",
  "compliance",
  "security",
  "executor",
  "sniper",
  "test-author",
  "harvester",
  "shipper",
];

const HAND_TOKEN_PATTERNS = [
  /OLLAMA_HAND_TOKEN/,
  /ANTHROPIC_AUTH_TOKEN/,
  /HAND_TOKEN/,
  /process\.env\s*(?:\.|\[)\s*['"]?(?:OLLAMA|ANTHROPIC|HAND)[^'"]*TOKEN/i,
];

/**
 * `statSync` follows symlinks, so a link pointing at an ancestor would recurse forever.
 * The visited set keys on realpath, which collapses any such cycle into a single visit.
 * @param {string} dir
 * @param {(abs: string, rel: string) => void} visit
 * @param {string} [base]
 * @param {Set<string>} [visited]
 */
function walkFiles(dir, visit, base = dir, visited = new Set()) {
  if (!existsSync(dir)) return;
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      walkFiles(abs, visit, base, visited);
    } else if (st.isFile()) {
      visit(abs, relative(base, abs));
    }
  }
}

/**
 * @param {string} targetDir
 * @returns {"opencode"|"claude"}
 */
export function detectTargetKind(targetDir) {
  if (existsSync(join(targetDir, "plugin", "entry-gate.ts"))) return "opencode";
  if (existsSync(join(targetDir, "hooks", "entry-gate.mjs"))) return "claude";
  if (String(targetDir).includes("opencode")) return "opencode";
  return "claude";
}

/**
 * @param {string} targetDir
 * @param {"opencode"|"claude"} [kind]
 */
export function checkAgentsPresent(targetDir, kind) {
  const k = kind ?? detectTargetKind(targetDir);
  const required = k === "opencode" ? OC_REQUIRED_AGENTS : CC_REQUIRED_AGENTS;
  const agentsDir = join(targetDir, "agents");
  if (!existsSync(agentsDir)) return { ok: false, missing: [...required], present: [] };
  const present = [];
  const missing = [];
  for (const a of required) {
    const f = join(agentsDir, `${a}.md`);
    if (existsSync(f)) present.push(a);
    else missing.push(a);
  }
  return { ok: missing.length === 0, present, missing };
}

/**
 * @param {string} targetDir
 */
export function checkDualConfig(targetDir) {
  const routing = join(targetDir, "harness.routing.json");
  if (!existsSync(routing)) {
    if (detectTargetKind(targetDir) === "claude") {
      return { ok: true, skipped: true, reason: "claude has no harness.routing.json dual map" };
    }
    return { ok: false, reason: "no routing file" };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(routing, "utf8"));
  } catch (err) {
    return { ok: false, reason: `invalid routing JSON: ${err.message}` };
  }
  const validation = validateRouting(json);
  return validation.ok ? { ok: true } : { ok: false, reason: validation.reason };
}

/**
 * @description REAL recursive scan of OC plugin/** for hand auth token reads.
 * Spec 08 §3.5: plugins must not read OLLAMA_HAND_TOKEN / ANTHROPIC_AUTH_TOKEN.
 * Claude hooks may legitimately reference hand tokens for Ollama dispatch — skip CC.
 * @param {string} targetDir
 */
export function checkNoTokenReads(targetDir) {
  const kind = detectTargetKind(targetDir);
  if (kind !== "opencode") {
    return { ok: true, skipped: true, hits: [], reason: "token ban applies to OC plugins only" };
  }
  const scanRoots = [join(targetDir, "plugin")];
  const missingRoots = scanRoots.filter((root) => !existsSync(root));
  if (missingRoots.length > 0) {
    return { ok: false, hits: [], missingRoots: missingRoots.map((r) => relative(targetDir, r)) };
  }
  const hits = [];
  for (const root of scanRoots) {
    walkFiles(root, (abs, rel) => {
      if (!/\.(ts|js|mjs|cjs|tsx|jsx)$/.test(abs)) return;
      if (abs.endsWith(".test.mjs") || abs.endsWith(".test.ts")) return;
      let text;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      for (const re of HAND_TOKEN_PATTERNS) {
        if (re.test(text)) {
          hits.push({ file: rel, pattern: String(re) });
          break;
        }
      }
    });
  }
  return { ok: hits.length === 0, hits, missingRoots: [] };
}

/** Extensions OpenCode auto-globs from `<target>/plugin/`. */
const PLUGIN_ENTRY_RE = /\.(ts|js)$/;

/** Source extensions worth scanning for import specifiers. */
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * A broken plugin is skipped by OpenCode in silence (exit 0, no log), so absence of error
 * proves nothing — only a real import does. Static `from`, side-effect `import "..."` and
 * literal dynamic `import("...")` are the three shapes that carry a relative specifier.
 *
 * NOT covered, so the guarantee has an edge worth knowing: `require("./x")`,
 * `createRequire(...)("./x")`, and any non-literal `import()` — template literal, string
 * concatenation, or a variable. Zero occurrences in this repo today; a future one resolves
 * silently here and only explodes at runtime.
 */
const IMPORT_TRIVIA_PATTERN = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;

const RELATIVE_IMPORT_PATTERNS = [
  new RegExp(String.raw`\bfrom${IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']`, "g"),
  new RegExp(
    String.raw`\bimport${IMPORT_TRIVIA_PATTERN}\(${IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']${IMPORT_TRIVIA_PATTERN}(?=[,)])`,
    "g",
  ),
  new RegExp(String.raw`\bimport${IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']`, "g"),
];

/**
 * Anchored to the start of a line on purpose. An unanchored `/\*[\s\S]*?\*\//` treats the `/*`
 * inside a regex literal such as `/[/*]/` as an opening delimiter and then swallows every import
 * up to the next closing delimiter — silencing the check instead of failing it. Anchoring keeps every block
 * comment in this repo stripped (measured: 0 false positives across core, scripts and modules)
 * while no such literal can open a phantom block, since a `/*` that starts a line is a comment
 * to the JS parser too.
 */
const BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\//gm;
const WHOLE_LINE_COMMENT_RE = /^[ \t]*\/\/.*$/gm;

const SPECIFIER_EXTENSIONS = ["", ".mjs", ".js", ".ts", ".cjs", ".mts", ".cts", ".json"];
const SPECIFIER_INDEX_FILES = ["index.mjs", "index.js", "index.ts"];

/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {boolean}
 */
function specifierResolvesOnDisk(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const ext of SPECIFIER_EXTENSIONS) {
    const candidate = base + ext;
    try {
      if (statSync(candidate).isFile()) return true;
    } catch {
      /* candidate absent */
    }
  }
  return SPECIFIER_INDEX_FILES.some((name) => existsSync(join(base, name)));
}

/** Deterministic stand-in for the small host API plugins need while their factories initialize. */
const HOST_PLUGIN_STUB = `
  const schemaValue = {
    optional() { return this },
    describe() { return this },
  };
  export const Plugin = Symbol("Plugin");
  export const Hooks = Symbol("Hooks");
  export const PluginInput = Symbol("PluginInput");
  export const tool = (definition) => definition;
  tool.schema = {
    string() { return Object.create(schemaValue) },
    object() { return Object.create(schemaValue) },
  };
`;

const HOST_PLUGIN_STUB_URL = `data:text/javascript,${encodeURIComponent(HOST_PLUGIN_STUB)}`;

/**
 * `@opencode-ai/plugin` is injected by the OpenCode host and deliberately absent from CI. Stub
 * only its exact public entry points so module import, default export, and factory execution stay
 * mandatory; a typo or any unrelated missing package still fails through Node's resolver.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin" || specifier === "@opencode-ai/plugin/tool") {
      return { url: HOST_PLUGIN_STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/**
 * @description Minimal OpenCode plugin context for a factory call.
 * @param {string} root throwaway project root, so a factory that reads harness state on load
 * sees an empty project instead of this repo
 * @returns {{directory: string, worktree: string, client: object, $: Function, project: object}}
 */
function pluginContextStub(root) {
  return {
    directory: root,
    worktree: root,
    client: {},
    $: () => {},
    project: { id: "parity-manifest", worktree: root },
  };
}

/**
 * @description Positive proof that every auto-globbed plugin of `<targetDir>/plugin/` really
 * loads: each `*.{ts,js}` is imported for real, must default-export a function, and that factory
 * is **called** with a context stub and must return an object of hooks. Calling it is the point:
 * most plugins resolve their libs with `await import(...)` inside the factory, so a plain module
 * import proves only the static slice of the graph — the very slice OpenCode does not stop at.
 * The host package is replaced by a deterministic stub, so every plugin is checked through
 * import, default-export, and factory-return validation. Also asserts the expected harness plugin
 * set is present. Never throws — a broken plugin comes back as a failure entry.
 * @param {string} targetDir
 * @returns {Promise<{ok: boolean, files: string[], failures: {file: string, reason: string}[], missing: string[]}>}
 */
export async function checkPluginLoad(targetDir) {
  const pluginDir = join(targetDir, "plugin");
  const expected = harnessOcPluginFiles().map((entry) => entry.split("/").pop());
  if (!existsSync(pluginDir)) {
    return {
      ok: false,
      files: [],
      failures: [{ file: "plugin", reason: "plugin directory does not exist" }],
      missing: expected,
    };
  }
  const files = readdirSync(pluginDir).filter((name) => PLUGIN_ENTRY_RE.test(name)).sort();
  const failures = [];
  const ctxRoot = mkdtempSync(join(tmpdir(), "parity-plugin-ctx-"));
  try {
    for (const name of files) {
      let mod;
      try {
        mod = await import(pathToFileURL(join(pluginDir, name)).href);
      } catch (err) {
        failures.push({ file: name, reason: `import failed: ${err?.message ?? String(err)}` });
        continue;
      }
      if (typeof mod.default !== "function") {
        failures.push({ file: name, reason: `default export is ${typeof mod.default}, expected function` });
        continue;
      }
      try {
        const hooks = await mod.default(pluginContextStub(ctxRoot));
        if (!hooks || typeof hooks !== "object") {
          failures.push({
            file: name,
            reason: `factory returned ${hooks === null ? "null" : typeof hooks}, expected an object of hooks`,
          });
        }
      } catch (err) {
        failures.push({ file: name, reason: `factory call failed: ${err?.message ?? String(err)}` });
      }
    }
  } finally {
    rmSync(ctxRoot, { recursive: true, force: true });
  }
  const missing = expected.filter((name) => !files.includes(name));
  return { ok: failures.length === 0 && missing.length === 0, files, failures, missing };
}

/**
 * @description Asserts every RELATIVE import specifier under `<targetDir>` points at a file that
 * exists on disk — static and literal-dynamic alike. Dynamic ones are the dangerous half: the
 * module registers fine and only explodes at the call site, mid-run. Bare and `node:` specifiers
 * are ignored.
 *
 * Test files are out of scope: they embed source fixtures as string literals (which read as
 * imports to any regex), and a test whose import is broken fails loudly under `node --test` —
 * the silent-skip failure mode this guards against is runtime-only. Comments are stripped for
 * the same reason: prose quoting a path is not a dependency.
 *
 * A target that does not exist, or under which no source file was walked, fails: "nothing
 * scanned" and "everything resolves" are indistinguishable in the return value otherwise, and a
 * vacuous green is the exact failure mode this net exists to remove.
 * @param {string} targetDir
 * @returns {{ok: boolean, unresolved: {file: string, specifier: string}[], readErrors: {file: string, reason: string}[], scanned: number, reason?: string}}
 */
export function checkImportsResolve(targetDir) {
  if (!existsSync(targetDir)) {
    return {
      ok: false,
      unresolved: [],
      readErrors: [],
      scanned: 0,
      reason: `target does not exist: ${targetDir}`,
    };
  }
  const unresolved = [];
  const readErrors = [];
  let scanned = 0;
  walkFiles(targetDir, (abs, rel) => {
    if (!SOURCE_FILE_RE.test(abs)) return;
    if (/\.test\.(mjs|ts|js)$/.test(abs)) return;
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch (err) {
      readErrors.push({ file: rel, reason: err?.message ?? String(err) });
      return;
    }
    const text = raw.replace(BLOCK_COMMENT_RE, "").replace(WHOLE_LINE_COMMENT_RE, "");
    scanned += 1;
    const seen = new Set();
    for (const re of RELATIVE_IMPORT_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const specifier = match[1];
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        if (!specifierResolvesOnDisk(abs, specifier)) unresolved.push({ file: rel, specifier });
      }
    }
  });
  if (scanned === 0) {
    return {
      ok: false,
      unresolved,
      readErrors,
      scanned,
      reason: readErrors.length > 0
        ? `no readable source file under ${targetDir}`
        : `no source file under ${targetDir}`,
    };
  }
  return { ok: unresolved.length === 0 && readErrors.length === 0, unresolved, readErrors, scanned };
}

/**
 * @description Assert real gate + oracle files exist (not directory-name theater).
 * @param {string} targetDir
 */
export function checkGatesAndOracle(targetDir) {
  const kind = detectTargetKind(targetDir);
  const missing = [];
  if (kind === "opencode") {
    for (const rel of ["plugin/entry-gate.ts", "plugin/plan-gate.ts"]) {
      if (!existsSync(join(targetDir, rel))) missing.push(rel);
    }
    const oracleCandidates = [
      join(targetDir, "shared", "lib", "capture-oracle.mjs"),
      join(targetDir, "..", "shared", "lib", "capture-oracle.mjs"),
    ];
    if (!oracleCandidates.some((p) => existsSync(p))) {
      missing.push("capture-oracle.mjs");
    }
  } else {
    for (const rel of ["hooks/entry-gate.mjs"]) {
      if (!existsSync(join(targetDir, rel))) missing.push(rel);
    }
    // CC plan validation lives in hooks / skills; oracle is shared sibling when monorepo
    const oracleCandidates = [
      join(targetDir, "..", "shared", "lib", "capture-oracle.mjs"),
      join(targetDir, "hooks", "lib", "capture-oracle.mjs"),
    ];
    if (!oracleCandidates.some((p) => existsSync(p))) {
      missing.push("capture-oracle.mjs");
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * @description Synchronous roll-up of the file-level parity checks.
 *
 * `checkPluginLoad` is deliberately NOT here: it is async, and making this async would ripple
 * into `t11-smoke`, whose fixture is a structural vendoring skeleton (`export {}` stubs) that
 * cannot satisfy a real factory call. The load proof runs as its own test against the real repo
 * (`t11-plugin-load`), which is where a plugin that stops loading actually has to be caught.
 * @param {string[]} [targets]
 */
export function runParity(targets = ["core/claude-code", "core/opencode"]) {
  const results = {};
  for (const t of targets) {
    const kind = detectTargetKind(t);
    results[t] = {
      kind,
      agents: checkAgentsPresent(t, kind),
      dual: checkDualConfig(t),
      tokens: checkNoTokenReads(t),
      gates: checkGatesAndOracle(t),
      imports: checkImportsResolve(t),
    };
  }
  const allOk = Object.values(results).every(
    (r) => r.agents.ok && r.dual.ok && r.tokens.ok && r.gates.ok && r.imports.ok,
  );
  return { ok: allOk, results };
}
