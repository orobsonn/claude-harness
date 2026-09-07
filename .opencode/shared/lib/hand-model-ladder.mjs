/**
 * @description The approved hand ladders — the SINGLE source of truth for which models may run
 * as a hand, which transport each one dispatches over, and which ladder the authoring rail
 * demands. Imported by `spawn-hand.mjs` (the dispatch rail), `descriptor-emitter.mjs` (the
 * resolution rail) and `plan-write-gate.mjs` (the authoring rail), so the ladders can never
 * drift between them.
 *
 * TWO FAMILIES, two DISPATCH MODES — the model id decides which:
 *   - `ollama` — external hands: an isolated `claude -p` child against https://ollama.com, with a
 *     hand token, the frozen-test gate armed in an ephemeral config dir, and an independent
 *     capture (`spawn-hand.mjs`).
 *   - `claude` — ordinary subagents: dispatched with the `Agent` tool like every other role, on
 *     the operator's own session auth. No token, no third-party endpoint, no spawn layer. The
 *     `high` rung is the SAME model as `medium` at a higher reasoning effort (`effort` in the
 *     agent's frontmatter), which is why the rung — not the id — is the unit of escalation.
 *
 * ALLOWLIST, not a denylist: closing the door only on the model that burned a run
 * (`gpt-oss:120b`, whose tool-calling breaks in a multi-step agentic loop) would leave every
 * other unvetted id open. STATIC by design — a network probe here would be either fail-open
 * theatre or hostage to an endpoint's uptime.
 *
 * WHICH FAMILY IS ACTIVE is an AUTHORING-time decision, never a dispatch-time one
 * (`readActiveHandFamily`, consumed only by the plan-write gate). Once a plan is frozen, the
 * model ids IN THE PLAN are the contract: `dispatchModeFor` derives how to dispatch them from the
 * id itself. Flipping the toggle mid-delivery therefore cannot strand a frozen plan whose ids
 * belong to the other family — it only decides what the NEXT plan may pin.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @description Ollama base URL — every ollama-family hand dispatch targets this endpoint. */
export const OLLAMA_BASE_URL = "https://ollama.com";

/**
 * @description The approved ladders, weakest → strongest, keyed by family.
 *
 * The `claude` family pins `sonnet` on BOTH medium and high on purpose: the rung that escalates
 * is the reasoning effort (`HAND_EFFORT_BY_TIER`), not the model id. The ladder is still three
 * DISTINCT rungs — as (model, effort) pairs, which is what actually reaches the child process.
 */
export const HAND_LADDERS = Object.freeze({
  ollama: Object.freeze({
    low: "gemma4",
    medium: "glm-5.2",
    high: "kimi-k2.7-code",
  }),
  claude: Object.freeze({
    low: "haiku",
    medium: "sonnet",
    high: "sonnet",
  }),
});

/** @description The family names, in the order an operator sees them in an error message. */
export const HAND_FAMILIES = Object.freeze(Object.keys(HAND_LADDERS));

/**
 * @description Reasoning effort per (family, tier) — the ONLY thing separating the claude
 * family's medium rung from its high rung. Absent = the model's default effort, so the ollama
 * family (whose endpoint has no such control) simply has no entries.
 */
export const HAND_EFFORT_BY_TIER = Object.freeze({
  ollama: Object.freeze({}),
  claude: Object.freeze({ high: "xhigh" }),
});

/** @description Effort levels an agent definition's `effort:` frontmatter accepts. */
export const APPROVED_HAND_EFFORTS = Object.freeze(new Set(["low", "medium", "high", "xhigh", "max"]));

/**
 * @description The family every unresolved dispatch and every un-toggled project falls back to.
 * Claude hands need no token and no third-party endpoint, so they are the safe default; the
 * cheap ollama hands are an explicit opt-in (`writeActiveHandFamily`).
 */
export const DEFAULT_HAND_FAMILY = "claude";

/** @description model id → family. Built once; the two ladders share no id. */
const FAMILY_BY_MODEL = new Map(
  Object.entries(HAND_LADDERS).flatMap(([family, ladder]) =>
    Object.values(ladder).map((model) => [model, family]),
  ),
);

/** @description The approved ids across BOTH families, as a membership set. */
export const APPROVED_HAND_MODELS = new Set(FAMILY_BY_MODEL.keys());

/**
 * @description The ladder of a family.
 * @param {string} family
 * @returns {Record<string,string>}
 * @throws {Error} on an unknown family.
 */
export function ladderFor(family) {
  const ladder = HAND_LADDERS[/** @type {keyof typeof HAND_LADDERS} */ (family)];
  if (!ladder) {
    throw new Error(
      `unknown hand family ${JSON.stringify(family)} — approved families: ${HAND_FAMILIES.join(", ")}.`,
    );
  }
  return ladder;
}

/**
 * @description The model every unresolved dispatch of a family falls back to (its `medium` rung).
 * It is itself an approved model, so the fallback can never open the door to an id outside the
 * ladder.
 * @param {string} [family]
 * @returns {string}
 */
export function defaultHandModelFor(family = DEFAULT_HAND_FAMILY) {
  return ladderFor(family).medium;
}

/**
 * @description Whether a model id may run as a hand (either family).
 * @param {unknown} model
 * @returns {boolean}
 */
export function isApprovedHandModel(model) {
  return typeof model === "string" && APPROVED_HAND_MODELS.has(model);
}

/**
 * @description The family an approved model belongs to, or undefined for an unapproved id.
 * @param {unknown} model
 * @returns {string|undefined}
 */
export function familyOfHandModel(model) {
  return typeof model === "string" ? FAMILY_BY_MODEL.get(model) : undefined;
}

/**
 * @description The family a plan's `hand_tiers` map was authored against — derived from the ids
 * themselves, never from config. Returns null when the map is empty, unrecognized, or MIXES
 * families (a mixed ladder is not a family, and guessing one would silently pick a transport the
 * plan never declared).
 * @param {unknown} handTiers
 * @returns {string|null}
 */
export function detectHandFamily(handTiers) {
  if (!handTiers || typeof handTiers !== "object" || Array.isArray(handTiers)) return null;
  const families = new Set(
    Object.values(/** @type {Record<string, unknown>} */ (handTiers)).map((model) => familyOfHandModel(model)),
  );
  if (families.size !== 1) return null;
  const [only] = families;
  return only ?? null;
}

/**
 * @description Renders a family's ladder for an error message, e.g.
 * `low: gemma4 · medium: glm-5.2 · high: kimi-k2.7-code`.
 * @param {string} [family]
 * @returns {string}
 */
export function formatApprovedLadder(family = DEFAULT_HAND_FAMILY) {
  return Object.entries(ladderFor(family))
    .map(([tier, model]) => `${tier}: ${model}`)
    .join(" · ");
}

/** @description Renders BOTH ladders, for a message that must not presume a family. */
export function formatAllApprovedLadders() {
  return HAND_FAMILIES.map((family) => `${family} → ${formatApprovedLadder(family)}`).join(" | ");
}

/**
 * @description Resolves a hand model against the allowlist.
 *
 * Absence (undefined/null/empty) falls back to `family`'s medium rung and reports it via
 * `modelFallbackUsed` — the caller stamps that signal onto the descriptor and the run-record.
 * A fallback that does not announce itself is how the dead `qwen3-coder:480b` default survived
 * in the code long after the id started answering 410. The fallback stays INSIDE the family the
 * caller declares (the plan's own ladder, via `detectHandFamily`), so an absent tier can never
 * silently cross to the other transport.
 *
 * An id that is PRESENT but outside both ladders is a hard refusal, never a fallback: laundering
 * a forbidden id into an approved one would silently execute something other than what the plan
 * declared.
 *
 * @param {unknown} model - The model id from the descriptor / plan tier, if any.
 * @param {{ source?: string, family?: string }} [opts] - `source` names the origin in the error
 *   message; `family` is the ladder an ABSENT model falls back into.
 * @returns {{ model: string, modelFallbackUsed: boolean }}
 * @throws {Error} When `model` is a non-empty value outside both approved ladders.
 */
export function resolveHandModel(model, { source = "descriptor", family = DEFAULT_HAND_FAMILY } = {}) {
  if (model === undefined || model === null || model === "") {
    return { model: defaultHandModelFor(family), modelFallbackUsed: true };
  }
  if (isApprovedHandModel(model)) {
    return { model: /** @type {string} */ (model), modelFallbackUsed: false };
  }
  throw new Error(
    `hand model ${JSON.stringify(model)} (from the ${source}) is not in an approved hand ladder — ` +
      `refusing to dispatch. Approved models: ${formatAllApprovedLadders()}.`,
  );
}

/**
 * @description Resolves the reasoning effort for a (model, tier) pair — the claude family's high
 * rung is `sonnet` at `xhigh`, everything else runs at the model's default. Pure: derived from
 * the descriptor's own fields, never from config, so a frozen dispatch always resolves the same
 * effort it was emitted with.
 * @param {unknown} model
 * @param {unknown} tier
 * @returns {string|undefined}
 */
export function resolveHandEffort(model, tier) {
  const family = familyOfHandModel(model);
  if (!family || typeof tier !== "string") return undefined;
  return HAND_EFFORT_BY_TIER[/** @type {keyof typeof HAND_EFFORT_BY_TIER} */ (family)][tier];
}

/** @description The two ways a hand can be dispatched, keyed by family. */
export const DISPATCH_MODES = Object.freeze({ ollama: "spawn-hand", claude: "agent" });

/**
 * @description HOW a hand model is dispatched — `"spawn-hand"` (an isolated `claude -p` child
 * against the Ollama endpoint) or `"agent"` (an ordinary subagent on the operator's own session).
 * Derived from the MODEL ID — the frozen plan's own contract — never from a config file read at
 * dispatch time. That is what makes flipping the toggle mid-delivery harmless: an in-flight plan
 * keeps dispatching the way its ids always implied.
 * @param {unknown} model
 * @returns {"spawn-hand"|"agent"}
 * @throws {Error} on a model outside both ladders.
 */
export function dispatchModeFor(model) {
  const family = familyOfHandModel(model);
  if (!family) {
    throw new Error(
      `hand model ${JSON.stringify(model)} has no approved dispatch mode — ` +
        `approved models: ${formatAllApprovedLadders()}.`,
    );
  }
  return DISPATCH_MODES[/** @type {keyof typeof DISPATCH_MODES} */ (family)];
}

/**
 * @description The subagent type that carries a rung's reasoning effort. The `Agent` tool takes a
 * `model` override but no effort, so the effort lives in the agent DEFINITION's frontmatter —
 * `<role>-high` is the same role at `effort: xhigh`. Returns the plain role when the rung has no
 * effort, so the caller always has one name to dispatch.
 * @param {string} role - `executor` | `sniper`
 * @param {unknown} model
 * @param {unknown} tier
 * @returns {string}
 */
export function agentTypeForRung(role, model, tier) {
  return resolveHandEffort(model, tier) ? `${role}-high` : role;
}

// ---------------------------------------------------------------------------
// The operator toggle — AUTHORING-time only
// ---------------------------------------------------------------------------

/** @description Project-relative path of the toggle, beside the sibling `test-runner.json`. */
export const HAND_FAMILY_CONFIG_PATH = ".claude/hand-config/hands.json";

/**
 * @description Reads the family the operator has selected for NEW plans.
 *
 * Resolution: `<cwd>/.claude/hand-config/hands.json` (`{"family":"ollama"}`) → default
 * (`claude`). Deliberately NO env override: the ask is "I say it once and it sticks", and a
 * second source would mean a precedence rule to document and a silent way for a shell to
 * disagree with the committed file.
 *
 * FAIL CLOSED on a present-but-invalid file: an unreadable/corrupt/unknown value throws rather
 * than defaulting, so a typo can never silently author a plan against the other ladder.
 *
 * @param {string} [cwd]
 * @param {{ existsSync: Function, readFileSync: Function }} [fsImpl]
 * @returns {{ family: string, source: "config"|"default", path: string }}
 * @throws {Error} when the file exists but is unreadable, unparseable, or names an unknown family.
 */
export function readActiveHandFamily(cwd = process.cwd(), fsImpl = { existsSync, readFileSync }) {
  const path = join(cwd, ".claude", "hand-config", "hands.json");
  if (!fsImpl.existsSync(path)) {
    return { family: DEFAULT_HAND_FAMILY, source: "default", path };
  }
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${HAND_FAMILY_CONFIG_PATH} is not readable JSON (${err instanceof Error ? err.message : String(err)}) — ` +
        `expected {"family":"${HAND_FAMILIES.join('"|"')}"}.`,
    );
  }
  const family = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.family : undefined;
  if (!Object.hasOwn(HAND_LADDERS, String(family))) {
    throw new Error(
      `${HAND_FAMILY_CONFIG_PATH} names an unknown hand family ${JSON.stringify(family)} — ` +
        `approved families: ${HAND_FAMILIES.join(", ")}.`,
    );
  }
  return { family: String(family), source: "config", path };
}

/**
 * @description Persists the operator's family choice. Writing `claude` REMOVES nothing and
 * rewrites the file explicitly rather than deleting it, so the committed repo always states the
 * choice out loud instead of leaving the reader to infer it from an absent file.
 * @param {string} family
 * @param {string} [cwd]
 * @param {{ mkdirSync: Function, writeFileSync: Function }} [fsImpl]
 * @returns {{ family: string, path: string }}
 * @throws {Error} on an unknown family.
 */
export function writeActiveHandFamily(family, cwd = process.cwd(), fsImpl = { mkdirSync, writeFileSync }) {
  ladderFor(family); // throws on an unknown family before anything touches disk
  const dir = join(cwd, ".claude", "hand-config");
  const path = join(dir, "hands.json");
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path, `${JSON.stringify({ family }, null, 2)}\n`, "utf8");
  return { family, path };
}

// ---------------------------------------------------------------------------
// Thin CLI — `node .claude/shared/lib/hand-model-ladder.mjs use ollama|claude` / `... show`
// ---------------------------------------------------------------------------

/** @description Renders the current selection for the operator. */
function showActiveHandFamily() {
  const { family, source, path } = readActiveHandFamily();
  const suffix = source === "default" ? ` (default — no ${HAND_FAMILY_CONFIG_PATH})` : ` (${path})`;
  return `hand family: ${family}${suffix}\n  ${formatApprovedLadder(family)}`;
}

// Guard via realpath, never `argv[1] === import.meta.url`: a symlinked/vendored copy resolves to
// a different specifier and the CLI would silently never run.
if (process.argv[1]) {
  let invokedDirectly = false;
  try {
    invokedDirectly = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
  if (invokedDirectly) {
    const [command, value] = process.argv.slice(2);
    try {
      if (command === "show" || command === undefined) {
        process.stdout.write(`${showActiveHandFamily()}\n`);
      } else if (command === "use") {
        const { family, path } = writeActiveHandFamily(value);
        process.stdout.write(
          `hand family set to ${family} → ${path}\n  ${formatApprovedLadder(family)}\n` +
            `  Applies to the NEXT plan written; a frozen plan keeps the ladder it was authored with.\n`,
        );
      } else {
        process.stderr.write(
          `usage: node hand-model-ladder.mjs [show | use ${HAND_FAMILIES.join("|")}]\n`,
        );
        process.exit(2);
      }
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  }
}
