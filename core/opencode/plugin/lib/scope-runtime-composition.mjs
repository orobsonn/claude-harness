/** @description Process-local composition handshake executed only by loaded scope plugins. */

import crypto from "node:crypto";
import fs from "node:fs";

const processNonce = crypto.randomBytes(32);
const registrations = new Map();
const REQUIRED = Object.freeze(["plan-gate", "obs-hand", "plan-write-gate"]);

function rootKey(projectRoot) {
  try { return fs.realpathSync(projectRoot); } catch { return ""; }
}

/** @description Register one actually executing plugin factory in this host process. */
export function registerScopeComponent(projectRoot, component) {
  const root = rootKey(projectRoot);
  if (!root || !REQUIRED.includes(component)) return { ok: false };
  let current = registrations.get(root);
  if (!current) {
    current = new Map();
    registrations.set(root, current);
  }
  if (!current.has(component)) {
    current.set(component, crypto.createHmac("sha256", processNonce).update(`${root}\0${component}`).digest("hex"));
  }
  return { ok: true, identity: current.get(component) };
}

/** @description Enforce only after all real factories registered against the same real root. */
export function scopeRuntimeCompositionMode(projectRoot) {
  const current = registrations.get(rootKey(projectRoot));
  return current && REQUIRED.every((component) => typeof current.get(component) === "string")
    ? "enforce"
    : "shadow";
}

export default { registerScopeComponent, scopeRuntimeCompositionMode };
