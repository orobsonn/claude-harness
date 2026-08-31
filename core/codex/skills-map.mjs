import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAP_PATH = fileURLToPath(new URL("./skills-map.json", import.meta.url));

export function loadSkillMap(readFile = readFileSync) {
  return JSON.parse(readFile(MAP_PATH, "utf8"));
}

export function unportedSourceSkills(mapping, sourceSkills) {
  const mapped = new Set(mapping.map((row) => row.source));
  return [...new Set(sourceSkills)].filter((source) => !mapped.has(source)).sort();
}

