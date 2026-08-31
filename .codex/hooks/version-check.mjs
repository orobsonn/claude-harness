import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function parseSemver(value) {
  const match = typeof value === "string" && value.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function decide({ localVersion, remoteTag }) {
  const local = parseSemver(localVersion);
  const remote = parseSemver(remoteTag);
  if (!local || !remote || compareSemver(local, remote) >= 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Harness Codex desatualizado: vendored ${localVersion}; disponível ${remoteTag}. Rode o vendor de atualização e reinicie a sessão.`,
    },
  };
}

function projectRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

function paths(root = projectRoot()) {
  const codex = join(root, ".codex");
  return { version: join(codex, ".harness-version"), cache: join(codex, ".harness-version-check-cache") };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function fetchRemoteTag() {
  try {
    return execFileSync("gh", ["release", "view", "--repo", "orobsonn/claude-harness", "--json", "tagName", "-q", ".tagName"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function defaultReadLocalVersion() {
  try { return readFileSync(paths().version, "utf8").split(/\r?\n/, 1)[0]?.trim() || null; } catch { return null; }
}

function defaultResolveRemoteTag(nowMs = Date.now()) {
  const { cache } = paths();
  const stored = readJson(cache);
  if (typeof stored?.tag === "string" && typeof stored.cachedAt === "number" && stored.cachedAt <= nowMs && nowMs - stored.cachedAt < CACHE_TTL_MS) {
    return stored.tag;
  }
  const tag = fetchRemoteTag();
  if (!tag) return null;
  try {
    mkdirSync(join(cache, ".."), { recursive: true });
    const temporary = `${cache}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ tag, cachedAt: nowMs }), "utf8");
    renameSync(temporary, cache);
  } catch {}
  return tag;
}

export function evaluateVersionCheck(event, {
  env = process.env,
  readLocalVersion = defaultReadLocalVersion,
  resolveRemoteTag = defaultResolveRemoteTag,
} = {}) {
  if (event?.hook_event_name !== "SessionStart" || env.CODEX_REMOTE != null) return {};
  try {
    const localVersion = readLocalVersion();
    const remoteTag = localVersion ? resolveRemoteTag() : null;
    return decide({ localVersion, remoteTag }) ?? {};
  } catch {
    return {};
  }
}

async function main() {
  let event = {};
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    event = JSON.parse(input || "{}");
  } catch {}
  process.stdout.write(`${JSON.stringify(evaluateVersionCheck(event))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
