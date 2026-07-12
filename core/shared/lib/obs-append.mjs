/**
 * @description Pure fail-open observability outbox append/read for session-side producers.
 * Vendored into `.opencode/shared` — must NOT import core/vps (absent in project vendors).
 * Semantics mirror core/vps/obs-outbox appendEvent/readEvents (JSONL + ts stamp).
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @description Derives the append-only events log path from a meta path.
 * @param {string} metaPath
 * @returns {string}
 */
export function eventsPathFor(metaPath) {
  return String(metaPath).replace(/\.json$/, ".events.jsonl");
}

/**
 * @description True when meta JSON file exists on disk.
 * @param {string|null|undefined} metaPath
 * @param {{ existsSync?: typeof existsSync }} [io]
 * @returns {boolean}
 */
export function metaExists(metaPath, io = {}) {
  const exists = io.existsSync ?? existsSync;
  return typeof metaPath === "string" && metaPath.length > 0 && exists(metaPath);
}

/**
 * @description Append one event to the run outbox JSONL. Fail-open: never throws.
 * Stamps `ts` ISO when absent. No-op when metaPath is not a string.
 * @param {string} metaPath
 * @param {object} event
 * @param {{ appendFileSync?: typeof appendFileSync, mkdirSync?: typeof mkdirSync }} [io]
 * @returns {void}
 */
export function appendEvent(metaPath, event, io = {}) {
  if (typeof metaPath !== "string") return;
  const append = io.appendFileSync ?? appendFileSync;
  const mkdir = io.mkdirSync ?? mkdirSync;
  const eventsPath = eventsPathFor(metaPath);
  try {
    mkdir(dirname(eventsPath), { recursive: true });
    const stamped =
      event && typeof event === "object" && !Array.isArray(event) && event.ts == null
        ? { ...event, ts: new Date().toISOString() }
        : event;
    append(eventsPath, `${JSON.stringify(stamped)}\n`, "utf8");
  } catch {
    // fail-open
  }
}

/**
 * @description Read all complete JSONL events. Fail-open → [].
 * @param {string} metaPath
 * @param {{ readFileSync?: typeof readFileSync }} [io]
 * @returns {object[]}
 */
export function readEvents(metaPath, io = {}) {
  if (typeof metaPath !== "string") return [];
  const read = io.readFileSync ?? readFileSync;
  const eventsPath = eventsPathFor(metaPath);
  let raw;
  try {
    raw = read(eventsPath, "utf8");
  } catch {
    return [];
  }
  if (!raw || !String(raw).trim()) return [];
  const out = [];
  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip torn/unparseable line
    }
  }
  return out;
}
