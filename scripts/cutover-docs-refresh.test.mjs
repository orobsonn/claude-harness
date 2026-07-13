/** @description Locked prose-content assertions for the OC auto-merge fail-closed gate docs refresh: 10-cutover-global.md, 00-index.md, and 09-vps-headless.md must mention the runtime fail-closed gate (ocAutoMergeGateOpen / fail-closed+gate / precondition+gate) and must drop the stale "still OFF until T12+T13 proven" blanket-off framing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const STALE_BLANKET_OFF = "still OFF until T12+T13 proven";

/**
 * @description True when text mentions the runtime fail-closed gate for OC auto-merge, via
 * the concrete symbol name or a fail-closed/precondition + gate phrase pairing.
 * @param {string} text
 * @returns {boolean}
 */
function mentionsFailClosedGate(text) {
  const lower = text.toLowerCase();
  if (lower.includes("ocautomergegateopen")) return true;
  const hasGate = lower.includes("gate");
  if (!hasGate) return false;
  if (lower.includes("fail-closed")) return true;
  if (lower.includes("precondition")) return true;
  return false;
}

/**
 * @description True when text mentions the runtime precondition gate for OC auto-merge via
 * the "precondition" + "gate" + T12/T13/T15 phrasing, or the concrete ocAutoMergeGateOpen
 * symbol name.
 * @param {string} text
 * @returns {boolean}
 */
function mentionsPreconditionGateOrSymbol(text) {
  if (text.includes("ocAutoMergeGateOpen")) return true;
  const lower = text.toLowerCase();
  const hasPrecondition = lower.includes("precondition");
  const hasGate = lower.includes("gate");
  const hasTaskRef = lower.includes("t12") || lower.includes("t13") || lower.includes("t15");
  return hasPrecondition && hasGate && hasTaskRef;
}

describe("cutover-docs-refresh", () => {
  it("10-cutover-global.md mentions the runtime fail-closed gate and drops the stale blanket-OFF framing", () => {
    const contractPath = resolve(REPO_ROOT, "docs/specs/oc-port/10-cutover-global.md");
    const text = readFileSync(contractPath, "utf8");

    assert.ok(
      mentionsPreconditionGateOrSymbol(text),
      "10-cutover-global.md must mention the precondition gate and T12/T13/T15, or ocAutoMergeGateOpen"
    );
    assert.ok(
      !text.includes(STALE_BLANKET_OFF),
      `10-cutover-global.md must not contain the stale blanket-OFF phrase "${STALE_BLANKET_OFF}"`
    );
  });

  it("00-index.md and 09-vps-headless.md each mention the OC auto-merge precondition/fail-closed gate, and 00-index.md's T14 line drops the stale blanket-OFF framing", () => {
    const indexPath = resolve(REPO_ROOT, "docs/specs/oc-port/00-index.md");
    const vpsPath = resolve(REPO_ROOT, "docs/specs/oc-port/09-vps-headless.md");
    const indexText = readFileSync(indexPath, "utf8");
    const vpsText = readFileSync(vpsPath, "utf8");

    assert.ok(
      mentionsFailClosedGate(indexText),
      "00-index.md must mention the OC auto-merge precondition/fail-closed gate"
    );
    assert.ok(
      mentionsFailClosedGate(vpsText),
      "09-vps-headless.md must mention the OC auto-merge precondition/fail-closed gate"
    );

    const t14Line = indexText
      .split("\n")
      .find((line) => line.includes("T14"));
    assert.ok(t14Line, "00-index.md must still have a T14 dependency-graph line");
    assert.ok(
      !t14Line.includes(STALE_BLANKET_OFF),
      `00-index.md's T14 line must not contain the stale blanket-OFF phrase "${STALE_BLANKET_OFF}", got: ${t14Line}`
    );
  });
});
