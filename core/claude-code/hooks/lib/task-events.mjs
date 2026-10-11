/**
 * @description Host reader for a lane's native evidence: the `claude -p --output-format
 * stream-json` events the supervisor recorded per launch (events.jsonl, written outside the
 * model's reach) and the hook ledger (task-ledger.jsonl). It projects the lane MAIN LOOP's tool
 * calls in order — tool_use (assistant, parent_tool_use_id null) joined to its tool_result and
 * structured `tool_use_result` — and attaches the ledger's pre/post HEAD and tree state by
 * tool_use_id. Formats are the ones captured in the spike (docs/claude-parallel-tasks-spike-*.md §2).
 */
import fs from "node:fs";

import { parseTaskDispatchMarker } from "./task-lane-contract.mjs";

const MAX_EVENTS_BYTES = 64 * 1024 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

function readLines(file, limit) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`evidence file is not a regular file: ${file}`);
  if (info.size > limit) throw new Error(`evidence file exceeds ${limit} bytes: ${file}`);
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
}

function resultText(block) {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
  return "";
}

/** Text of a structured Agent tool_use_result (`content` text blocks). */
function structuredText(structured) {
  if (!structured || typeof structured !== "object") return "";
  return resultText(structured);
}

/**
 * Parse every launch's events.jsonl into ordered main-loop calls.
 * @param {Array<{events_path: string}>} launches
 * @returns {{ sessionIds: Set<string>, inits: Array<{launchIndex:number,cwd:string}>, results: Array<object|null>,
 *   calls: object[], finalText: string, unparsed: number }}
 */
export function readLaneEvents(launches) {
  const sessionIds = new Set();
  const inits = [];
  const results = [];
  const calls = [];
  const byId = new Map();
  let finalText = "";
  let unparsed = 0;
  let seq = 0;
  for (const [launchIndex, launch] of launches.entries()) {
    let lines = [];
    try {
      lines = readLines(launch.events_path, MAX_EVENTS_BYTES);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let lastResult = null;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        unparsed += 1;
        continue;
      }
      if (!event || typeof event !== "object") continue;
      if (typeof event.session_id === "string") sessionIds.add(event.session_id);
      if (event.type === "system" && event.subtype === "init") inits.push({ launchIndex, cwd: event.cwd });
      if (event.type === "result") lastResult = { subtype: event.subtype, is_error: event.is_error === true, text: typeof event.result === "string" ? event.result : "" };
      const mainLoop = event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;
      if (!mainLoop || !Array.isArray(event.message?.content)) continue;
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string" && launchIndex === launches.length - 1) finalText = block.text;
          if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
          const input = block.input && typeof block.input === "object" ? block.input : {};
          const call = {
            seq: seq++, launchIndex, id: block.id, tool: block.name, input,
            role: typeof input.subagent_type === "string" ? input.subagent_type.slice(input.subagent_type.lastIndexOf(":") + 1) : null,
            model: typeof input.model === "string" ? input.model : null,
            command: typeof input.command === "string" ? input.command : null,
            marker: block.name === "Agent" || block.name === "Task" ? parseTaskDispatchMarker(input.prompt) : null,
            end: null,
          };
          calls.push(call);
          byId.set(block.id, call);
        }
      } else if (event.type === "user") {
        for (const block of event.message.content) {
          if (block?.type !== "tool_result" || !byId.has(block.tool_use_id)) continue;
          const call = byId.get(block.tool_use_id);
          const structured = event.tool_use_result && typeof event.tool_use_result === "object" ? event.tool_use_result : null;
          call.end = {
            isError: block.is_error === true,
            text: resultText(block) || structuredText(structured),
            structured,
          };
        }
      }
    }
    results.push(lastResult);
  }
  for (const call of calls) {
    call.ok = Boolean(call.end) && call.end.isError !== true;
    call.agentStatus = call.end?.structured?.status ?? null;
    call.agentId = call.end?.structured?.agentId ?? null;
    call.isAsync = call.end?.structured?.isAsync === true || call.agentStatus === "async_launched";
    call.text = call.end?.text ?? "";
  }
  return { sessionIds, inits, results, calls, finalText, unparsed };
}

/** Ledger lines by tool_use_id: { pre, post } for the lane main loop (agent_id null) and subagents. */
export function readLaneLedger(file) {
  const byId = new Map();
  let lines = [];
  try {
    lines = readLines(file, MAX_LEDGER_BYTES);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.v !== 1 || typeof record.tool_use_id !== "string" || !["pre", "post"].includes(record.event)) continue;
    const slot = byId.get(record.tool_use_id) ?? {};
    // First pre and last post win: a retried hook never rewrites the boundary already observed.
    if (record.event === "pre" && !slot.pre) slot.pre = record;
    if (record.event === "post") slot.post = record;
    byId.set(record.tool_use_id, slot);
  }
  return byId;
}

/** Attach ledger boundaries to each call (main-loop records only; agent_id must be null). */
export function attachLedger(calls, ledger) {
  for (const call of calls) {
    const slot = ledger.get(call.id) ?? {};
    const mainLoop = (record) => record && record.agent_id === null ? record : null;
    call.pre = mainLoop(slot.pre);
    call.post = mainLoop(slot.post);
  }
  return calls;
}
