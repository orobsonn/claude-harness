/**
 * @description Per-run outbox persistence lib (scaffold — implemented by the task-2 executor).
 * Split persistence: obs-<issue>.json (meta, atomic temp->rename) + obs-<issue>.events.jsonl
 * (append-only). Zero-dep, fail-open. Present as throwing stubs only so the frozen test collects.
 */
/** @description Scaffold. */ export function createRun() { throw new Error("not implemented"); }
/** @description Scaffold. */ export function appendEvent() { throw new Error("not implemented"); }
/** @description Scaffold. */ export function readEvents() { throw new Error("not implemented"); }
/** @description Scaffold. */ export function readMeta() { throw new Error("not implemented"); }
/** @description Scaffold. */ export function advanceCursor() { throw new Error("not implemented"); }
/** @description Scaffold. */ export function updateMeta() { throw new Error("not implemented"); }
