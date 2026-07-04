#!/usr/bin/env node
/**
 * @description VPS cron installer — THROWING SCAFFOLD (freeze baseline). Exports the exact named
 * symbols install-crons.test.mjs imports so the frozen suite COLLECTS (>0 tests) and stays
 * legitimately RED until the executor replaces each body with the real implementation. Every
 * export throws "not implemented" — no logic is committed at freeze time.
 */

const NOT_IMPLEMENTED = "install-crons: not implemented";

export function validateInstallCoordinates() {
  throw new Error(NOT_IMPLEMENTED);
}

export function generateProjectConfig() {
  throw new Error(NOT_IMPLEMENTED);
}

export function renderProjectBlock() {
  throw new Error(NOT_IMPLEMENTED);
}

export function renderReaperBlock() {
  throw new Error(NOT_IMPLEMENTED);
}

export function upsertBlock() {
  throw new Error(NOT_IMPLEMENTED);
}

export function removeBlock() {
  throw new Error(NOT_IMPLEMENTED);
}

export function listRegisteredProjects() {
  throw new Error(NOT_IMPLEMENTED);
}

export function reconcileFleet() {
  throw new Error(NOT_IMPLEMENTED);
}

export function removeFromFleetConfig() {
  throw new Error(NOT_IMPLEMENTED);
}

export function readConfigFile() {
  throw new Error(NOT_IMPLEMENTED);
}

export function readCrontab() {
  throw new Error(NOT_IMPLEMENTED);
}

export function writeCrontab() {
  throw new Error(NOT_IMPLEMENTED);
}

export function atomicWriteConfig() {
  throw new Error(NOT_IMPLEMENTED);
}

export function withInstallLock() {
  throw new Error(NOT_IMPLEMENTED);
}

export function installProject() {
  throw new Error(NOT_IMPLEMENTED);
}

export function uninstallProject() {
  throw new Error(NOT_IMPLEMENTED);
}
