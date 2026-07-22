/** @description
 * Pure core for the configure-routing native tool. Kept in .mjs so it is unit-testable
 * with `node --test` (the .ts wrapper only binds it to the OC tool runtime).
 *
 * Security invariants (adversarial review, routing-config-lane):
 *  - targetRoot is ALWAYS the caller cwd (context.directory) — never from args (no traversal).
 *  - Weak-eye confirm flags default false; the config lane is operator-turn only.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @description Parse slots arg into an object (accepts object or JSON string).
 * @param {unknown} raw
 * @returns {{ ok: true, slots: object | null } | { ok: false, reason: string }}
 */
export function parseSlots(raw) {
  if (raw === undefined || raw === null) return { ok: true, slots: null };
  if (typeof raw === "object" && !Array.isArray(raw)) return { ok: true, slots: raw };
  if (typeof raw === "object") return { ok: false, reason: "slots must be an object, not an array" };
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return { ok: true, slots: null };
    try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "slots JSON must be an object" };
      }
      return { ok: true, slots: parsed };
    } catch (e) {
      return { ok: false, reason: `slots JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: false, reason: "slots must be an object or JSON string" };
}

function payload(title, body) {
  return { title, output: JSON.stringify(body, null, 2), metadata: body };
}

/**
 * @description Run the configure-routing tool logic against an injected engine.
 * @param {object} args
 * @param {{ directory: string }} context
 * @param {object} engine  apply-routing.mjs module (injectable for tests)
 * @returns {Promise<{ title: string, output: string, metadata: object }>}
 */
export async function runConfigureRouting(args, context, engine) {
  // targetRoot pinned to cwd — never from args.
  const targetRoot = context.directory;
  const action = typeof args?.action === "string" && args.action.trim() ? args.action.trim() : "apply";

  if (action === "inspect") {
    let current = null;
    for (const rel of ["harness.routing.json", ".opencode/harness.routing.json"]) {
      const p = path.resolve(targetRoot, rel);
      if (fs.existsSync(p)) {
        try {
          current = JSON.parse(fs.readFileSync(p, "utf8"));
          break;
        } catch {
          /* ignore malformed */
        }
      }
    }
    return payload("configure-routing: inspect", {
      ok: true,
      action: "inspect",
      presets: engine.listPresets(),
      touchpoints: engine.listRoutingTouchpoints(),
      current,
    });
  }

  if (action !== "apply") {
    return payload("configure-routing: invalid action", {
      ok: false,
      reason: `unknown action '${action}' — use 'inspect' or 'apply'`,
    });
  }

  const presetId = typeof args?.preset === "string" ? args.preset.trim() : "";
  let built;
  if (presetId) {
    built = engine.routingFromPreset(presetId);
  } else {
    const parsed = parseSlots(args?.slots);
    if (!parsed.ok) return payload("configure-routing: bad slots", { ok: false, reason: parsed.reason });
    if (!parsed.slots) {
      return payload("configure-routing: missing input", {
        ok: false,
        reason: "pass a preset id (primary) or slots object (escape hatch)",
      });
    }
    built = engine.buildRoutingFromSlots(parsed.slots);
  }
  if (!built.ok) return payload("configure-routing: build rejected", { ok: false, reason: built.reason });

  const applied = engine.applyRoutingToDisk({
    targetRoot,
    routing: built.routing,
    updateOpencodeJson: args?.update_opencode_json !== false,
    confirmWeakEyes: args?.confirm_weak_eyes === true,
    confirmWeakJudgmentEyes: args?.confirm_weak_judgment_eyes === true,
    forceCoreGrok: args?.force_core_grok === true,
  });

  if (!applied.ok) return payload("configure-routing: apply rejected", { ok: false, reason: applied.reason });
  return payload(`configure-routing: applied (${applied.changed.length} file(s))`, {
    ok: true,
    changed: applied.changed,
    warnings: applied.warnings,
  });
}
