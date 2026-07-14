/** @description Parity manifesto CI checker: verifies both runtime targets have required agents, dual config, gates, oracle, no token reads; used by parity-manifest.test.mjs and CI. */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateRouting } from "../core/shared/lib/routing-validate.mjs";

/** OC-canonical agent files (tiered executor/sniper). */
export const OC_REQUIRED_AGENTS = [
  "build",
  "planner",
  "plan-reviewer",
  "plan-reviewer-openai",
  "plan-reviewer-family-1",
  "plan-reviewer-family-2",
  "adversary",
  "adversary-openai",
  "adversary-family-1",
  "adversary-family-2",
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
 * @param {string} dir
 * @param {(abs: string, rel: string) => void} visit
 * @param {string} [base]
 */
function walkFiles(dir, visit, base = dir) {
  if (!existsSync(dir)) return;
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
      walkFiles(abs, visit, base);
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
  return { ok: hits.length === 0, hits };
}

/**
 * @description Assert real gate + oracle files exist (not directory-name theater).
 * @param {string} targetDir
 */
export function checkGatesAndOracle(targetDir) {
  const kind = detectTargetKind(targetDir);
  const missing = [];
  if (kind === "opencode") {
    for (const rel of ["plugin/entry-gate.ts", "plugin/plan-gate.ts", "plugin/loop-guard.ts"]) {
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
    };
  }
  const allOk = Object.values(results).every(
    (r) => r.agents.ok && r.dual.ok && r.tokens.ok && r.gates.ok,
  );
  return { ok: allOk, results };
}
