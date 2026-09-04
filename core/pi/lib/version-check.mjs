/**
 * @description Version-check — lógica pura de advertência de harness stale na lane Pi. Porte de
 * `core/opencode/plugin/lib/version-check-core.ts` para .mjs: mesmas decisões (parseSemver,
 * compareSemver, decideStale, resolveRemoteTag com cache TTL), sem qualquer dependência de tipos
 * do OpenCode. Nunca bloqueia — é puramente uma advertência (fail-open em toda falha de I/O,
 * `gh` ausente ou rede indisponível).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Budget do cache da tag remota — evita round-trip de rede em todo bootstrap de sessão. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @description Candidato de raiz de projeto utilizável. Um diretório vazio ou "/" resolveria o
 * estado de versão contra a raiz do filesystem — inutilizável.
 */
function isUsableRoot(candidate) {
  return typeof candidate === "string" && candidate.length > 0 && candidate !== "/";
}

/**
 * @description Resolve a raiz do projeto — nunca vazia. Cai para `process.cwd()` quando o
 * candidato é "/" ou vazio.
 */
export function resolveProjectRoot(candidate) {
  if (isUsableRoot(candidate)) return candidate;
  return process.cwd();
}

/**
 * @description Extrai o semver líder de um carimbo de versão. Cobre as 3 formas que
 * `git describe --tags --always` produz: tag exata (`v0.49.8`), tag + commits à frente
 * (`v0.49.8-3-gabc1234`) e nenhuma tag alcançável (SHA puro) — a última não tem versão
 * comparável e resolve para null (decideStale então fica em silêncio, nunca lança).
 */
export function parseSemver(stamp) {
  if (typeof stamp !== "string") return null;
  const match = stamp.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** @description Comparação numérica de semver — nunca lexical. */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * @description Decide se o carimbo vendorizado está atrás do último release. Retorna a prosa de
 * advertência, ou null quando está atualizado / algum dos carimbos é não-parseável.
 */
export function decideStale({ localStamp, remoteTag }) {
  const local = parseSemver(localStamp);
  const remote = parseSemver(remoteTag);
  if (!local || !remote) return null;
  if (compareSemver(local, remote) >= 0) return null;
  return `⚠️ Harness Pi desatualizado — vendored ${localStamp}, disponível ${remoteTag}. Rode /updating-harness e reinicie a sessão para carregar a versão nova.`;
}

/**
 * @description Resolve a tag do último release, cacheando para que um bootstrap de sessão não
 * bata na rede toda vez. Cache ausente/expirado/com `cachedAt` no futuro dispara um
 * `fetchRemoteTag`.
 */
export function resolveRemoteTag({ nowMs, readCache, writeCache, fetchRemoteTag, ttlMs }) {
  const cache = readCache();
  if (
    cache &&
    typeof cache === "object" &&
    typeof cache.tag === "string" &&
    typeof cache.cachedAt === "number" &&
    cache.cachedAt <= nowMs &&
    nowMs - cache.cachedAt < ttlMs
  ) {
    return cache.tag;
  }
  const tag = fetchRemoteTag();
  if (tag) {
    writeCache({ tag, cachedAt: nowMs });
    return tag;
  }
  return null;
}

function readLocalVersionFromDisk(projectRoot) {
  try {
    const content = readFileSync(join(projectRoot, ".pi", ".harness-version"), "utf8");
    const firstLine = content.split("\n")[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

function readCacheFromDisk(projectRoot) {
  try {
    return JSON.parse(readFileSync(join(projectRoot, ".pi", ".harness-version-check-cache"), "utf8"));
  } catch {
    return null;
  }
}

function writeCacheToDisk(projectRoot, value) {
  try {
    const tmpPath = join(projectRoot, ".pi", ".harness-version-check-cache.tmp");
    const finalPath = join(projectRoot, ".pi", ".harness-version-check-cache");
    writeFileSync(tmpPath, JSON.stringify(value), "utf8");
    renameSync(tmpPath, finalPath);
  } catch {
    // fail-soft
  }
}

/** @description `gh` primeiro, `curl` contra a API do GitHub como fallback — ambos com budget de 2s. */
function fetchRemoteTagLive() {
  try {
    const output = execFileSync(
      "gh",
      ["release", "view", "--repo", "orobsonn/claude-harness", "--json", "tagName", "-q", ".tagName"],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" },
    );
    const tag = output.trim();
    return tag || null;
  } catch {
    try {
      const output = execFileSync(
        "curl",
        ["-fs", "--max-time", "2", "https://api.github.com/repos/orobsonn/claude-harness/releases/latest"],
        { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" },
      );
      const data = JSON.parse(output);
      const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
      return tag || null;
    } catch {
      return null;
    }
  }
}

/**
 * @description Checa se o carimbo vendorizado `.pi/.harness-version` está atrás do último
 * release. Fail-soft por construção: carimbo ausente, `gh`/rede inalcançável ou qualquer erro de
 * I/O resolve para null — sem advertência, sem lançar, sem atraso de bootstrap além do lookup
 * remoto cacheado/orçado.
 */
export function checkHarnessVersionStale(projectRoot, deps = {}) {
  try {
    const readLocalVersion = deps.readLocalVersion ?? readLocalVersionFromDisk;
    const localStamp = readLocalVersion(projectRoot);
    if (!localStamp) return null;

    const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
    const fetchRemoteTag = deps.fetchRemoteTag ?? fetchRemoteTagLive;
    const remoteTag = resolveRemoteTag({
      nowMs,
      readCache: () => (deps.readCache ? deps.readCache(projectRoot) : readCacheFromDisk(projectRoot)),
      writeCache: (value) => (deps.writeCache ? deps.writeCache(projectRoot, value) : writeCacheToDisk(projectRoot, value)),
      fetchRemoteTag,
      ttlMs: CACHE_TTL_MS,
    });
    if (!remoteTag) return null;

    return decideStale({ localStamp, remoteTag });
  } catch {
    return null;
  }
}
