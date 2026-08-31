import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const AGENTS_DIR = fileURLToPath(new URL("./agents/", import.meta.url));
const REQUIRED_FIELDS = ["name", "description", "developer_instructions", "sandbox_mode"];

function quotedValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match?.[1] ?? "";
}

function multilineValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"""\\n([\\s\\S]*?)\\n"""\\s*$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function parseAgentToml(text) {
  return {
    name: quotedValue(text, "name"),
    description: quotedValue(text, "description"),
    sandbox_mode: quotedValue(text, "sandbox_mode"),
    developer_instructions: multilineValue(text, "developer_instructions"),
  };
}

export function loadAgents(readFile = readFileSync, readDir = readdirSync) {
  return readDir(AGENTS_DIR)
    .filter((name) => name.endsWith(".toml"))
    .sort()
    .map((name) => parseAgentToml(readFile(join(AGENTS_DIR, name), "utf8")));
}

export function validateAgents(agents) {
  const issues = [];
  const names = new Set();
  for (const agent of agents) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof agent[field] !== "string" || agent[field].trim() === "") issues.push(`${agent.name || "<unnamed>"}: ${field} missing`);
    }
    if (names.has(agent.name)) issues.push(`duplicate agent: ${agent.name}`);
    names.add(agent.name);
    if (!["read-only", "workspace-write"].includes(agent.sandbox_mode)) issues.push(`${agent.name}: invalid sandbox mode`);
  }
  return issues;
}

