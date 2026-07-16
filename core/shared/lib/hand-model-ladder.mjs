/**
 * @description The approved cheap-hand model ladder — the SINGLE source of truth for which
 * Ollama models may run as a hand. Imported by `spawn-hand.mjs` (the dispatch rail) and
 * `plan-write-gate.mjs` (the authoring rail), so the ladder can never drift between the two.
 *
 * ALLOWLIST, not a denylist: closing the door only on the model that burned a run (`gpt-oss:120b`,
 * whose tool-calling breaks in a multi-step agentic loop) would leave every other unvetted id open.
 * STATIC by design — plan-write-gate is a pure decision layer with no token, so a network probe
 * here would be either fail-open theatre or hostage to the endpoint's uptime.
 */

/** @description The three verified hand models, weakest → strongest. */
export const APPROVED_HAND_LADDER = Object.freeze({
  low: 'gemma4',
  medium: 'glm-5.2',
  high: 'kimi-k2.7-code',
});

/**
 * @description The model every unresolved dispatch falls back to (the `medium` rung). It is itself
 * an approved model, so the fallback can never open the door to an id outside the ladder.
 */
export const DEFAULT_HAND_MODEL = APPROVED_HAND_LADDER.medium;

/** @description The approved ids as a membership set. */
export const APPROVED_HAND_MODELS = new Set(Object.values(APPROVED_HAND_LADDER));

/**
 * @description Whether a model id may run as a cheap hand.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isApprovedHandModel(model) {
  return typeof model === 'string' && APPROVED_HAND_MODELS.has(model);
}

/**
 * @description Renders the ladder for an error message, e.g. `low: gemma4 · medium: glm-5.2 · high: kimi-k2.7-code`.
 * @returns {string}
 */
export function formatApprovedLadder() {
  return Object.entries(APPROVED_HAND_LADDER)
    .map(([tier, model]) => `${tier}: ${model}`)
    .join(' · ');
}

/**
 * @description Resolves a hand model against the allowlist.
 *
 * Absence (undefined/null/empty) falls back to `DEFAULT_HAND_MODEL` and reports it via
 * `modelFallbackUsed` — the caller stamps that signal onto the descriptor and the run-record.
 * A fallback that does not announce itself is how the dead `qwen3-coder:480b` default survived
 * in the code long after the id started answering 410.
 *
 * An id that is PRESENT but outside the ladder is a hard refusal, never a fallback: laundering a
 * forbidden id into glm-5.2 would silently execute something other than what the plan declared.
 *
 * @param {unknown} model - The model id from the descriptor / plan tier, if any.
 * @param {{ source?: string }} [opts] - `source` names the origin in the error message.
 * @returns {{ model: string, modelFallbackUsed: boolean }}
 * @throws {Error} When `model` is a non-empty value outside the approved ladder.
 */
export function resolveHandModel(model, { source = 'descriptor' } = {}) {
  if (model === undefined || model === null || model === '') {
    return { model: DEFAULT_HAND_MODEL, modelFallbackUsed: true };
  }
  if (isApprovedHandModel(model)) {
    return { model: /** @type {string} */ (model), modelFallbackUsed: false };
  }
  throw new Error(
    `hand model ${JSON.stringify(model)} (from the ${source}) is not in the approved hand ladder — ` +
      `refusing to dispatch. Approved models: ${formatApprovedLadder()}.`,
  );
}
