// Testes trancados (locked then-clauses) para version-check — advisório, nunca bloqueia.
import assert from "node:assert";
import test from "node:test";
import { isHarnessInternalPath } from "../../shared/lib/capture-oracle.mjs";
import {
  CACHE_TTL_MS,
  checkHarnessVersionStale,
  compareSemver,
  decideStale,
  parseSemver,
  resolveProjectRoot,
  resolveRemoteTag,
} from "./version-check.mjs";

test("CACHE_TTL_MS é 6 horas", () => {
  assert.equal(CACHE_TTL_MS, 6 * 60 * 60 * 1000);
});

test("resolveProjectRoot usa o candidato quando é utilizável", () => {
  assert.equal(resolveProjectRoot("/project"), "/project");
});

test("resolveProjectRoot descarta raiz de filesystem ou vazia e cai para process.cwd()", () => {
  assert.equal(resolveProjectRoot("/"), process.cwd());
  assert.equal(resolveProjectRoot(""), process.cwd());
  assert.equal(resolveProjectRoot(undefined), process.cwd());
  assert.equal(resolveProjectRoot(null), process.cwd());
});

test("parseSemver lida com as 3 formas que git describe --tags --always produz", () => {
  assert.deepEqual(parseSemver("v0.49.8"), { major: 0, minor: 49, patch: 8 });
  assert.deepEqual(parseSemver("v0.49.8-3-gabc1234"), { major: 0, minor: 49, patch: 8 });
  assert.equal(parseSemver("a1b2c3d"), null);
  assert.equal(parseSemver(""), null);
  assert.equal(parseSemver(undefined), null);
});

test("compareSemver é numérico, não lexical", () => {
  assert.equal(compareSemver({ major: 0, minor: 9, patch: 0 }, { major: 0, minor: 10, patch: 0 }), -1);
  assert.equal(compareSemver({ major: 0, minor: 10, patch: 0 }, { major: 0, minor: 9, patch: 0 }), 1);
  assert.equal(compareSemver({ major: 0, minor: 49, patch: 8 }, { major: 0, minor: 49, patch: 8 }), 0);
  assert.equal(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 99, patch: 99 }), 1);
});

test("decideStale retorna a advertência quando o carimbo vendorizado está atrás (local < remoto)", () => {
  const message = decideStale({ localStamp: "v0.49.0", remoteTag: "v0.49.8" });
  assert.ok(message && message.includes("0.49.0") && message.includes("0.49.8"));
  assert.ok(message.includes("/updating-harness"));
  assert.match(message, /Harness Pi desatualizado/);
});

test("decideStale fica em silêncio quando o carimbo bate com o último release (local == remoto)", () => {
  assert.equal(decideStale({ localStamp: "v0.49.8", remoteTag: "v0.49.8" }), null);
});

test("decideStale fica em silêncio quando o local está à frente do remoto (local > remoto)", () => {
  assert.equal(decideStale({ localStamp: "v0.49.9", remoteTag: "v0.49.8" }), null);
  assert.equal(decideStale({ localStamp: "v1.0.0", remoteTag: "v0.99.99" }), null);
});

test("decideStale fica em silêncio num carimbo não-parseável (SHA puro) — fail-soft, nunca lança", () => {
  assert.equal(decideStale({ localStamp: "a1b2c3d", remoteTag: "v0.49.8" }), null);
  assert.equal(decideStale({ localStamp: "v0.49.0", remoteTag: "a1b2c3d" }), null);
});

test("resolveRemoteTag pula o fetch remoto num cache hit dentro do TTL", () => {
  let fetched = 0;
  const tag = resolveRemoteTag({
    nowMs: 1000 + 3_600_000,
    readCache: () => ({ tag: "v0.49.8", cachedAt: 1000 }),
    writeCache: () => { throw new Error("não deve escrever num cache hit"); },
    fetchRemoteTag: () => { fetched++; return "v9.9.9"; },
    ttlMs: 21_600_000,
  });
  assert.equal(tag, "v0.49.8");
  assert.equal(fetched, 0);
});

test("resolveRemoteTag descarta um cache com cachedAt no futuro e busca de novo", () => {
  let fetched = 0;
  const tag = resolveRemoteTag({
    nowMs: 1000,
    readCache: () => ({ tag: "v0.49.8", cachedAt: 5000 }),
    writeCache: () => {},
    fetchRemoteTag: () => { fetched++; return "v0.50.0"; },
    ttlMs: 21_600_000,
  });
  assert.equal(tag, "v0.50.0");
  assert.equal(fetched, 1);
});

test("resolveRemoteTag busca e cacheia quando o cache está ausente/expirado", () => {
  let writtenArg = null;
  const now = 7 * 3_600_000;
  const tag = resolveRemoteTag({
    nowMs: now,
    readCache: () => null,
    writeCache: (value) => { writtenArg = value; },
    fetchRemoteTag: () => "v0.49.8",
    ttlMs: 21_600_000,
  });
  assert.equal(tag, "v0.49.8");
  assert.deepEqual(writtenArg, { tag: "v0.49.8", cachedAt: now });
});

test("resolveRemoteTag retorna null e não escreve quando o fetch falha", () => {
  const tag = resolveRemoteTag({
    nowMs: 0,
    readCache: () => null,
    writeCache: () => { throw new Error("não deve escrever sem tag"); },
    fetchRemoteTag: () => null,
    ttlMs: 21_600_000,
  });
  assert.equal(tag, null);
});

test("checkHarnessVersionStale emite a advertência para um carimbo atrasado contra um release mockado mais novo", () => {
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => "v0.49.0",
    fetchRemoteTag: () => "v0.49.8",
    readCache: () => null,
    writeCache: () => {},
    nowMs: () => 0,
  });
  assert.ok(message && message.includes("v0.49.0") && message.includes("v0.49.8"));
});

test("checkHarnessVersionStale fica em silêncio quando o carimbo já está atualizado", () => {
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => "v0.49.8",
    fetchRemoteTag: () => "v0.49.8",
    readCache: () => null,
    writeCache: () => {},
    nowMs: () => 0,
  });
  assert.equal(message, null);
});

test("checkHarnessVersionStale falha aberto (sem advertência, sem lançar) quando gh/rede está indisponível", () => {
  assert.doesNotThrow(() => {
    const message = checkHarnessVersionStale("/project", {
      readLocalVersion: () => "v0.49.0",
      fetchRemoteTag: () => null,
      readCache: () => null,
      writeCache: () => {},
      nowMs: () => 0,
    });
    assert.equal(message, null);
  });
});

test("checkHarnessVersionStale falha aberto quando não há carimbo vendorizado — não chama fetch", () => {
  let fetchCalls = 0;
  const message = checkHarnessVersionStale("/project", {
    readLocalVersion: () => null,
    fetchRemoteTag: () => { fetchCalls++; return "v0.49.8"; },
  });
  assert.equal(message, null);
  assert.equal(fetchCalls, 0);
});

test("checkHarnessVersionStale falha aberto quando uma dependência lança", () => {
  assert.doesNotThrow(() => {
    const message = checkHarnessVersionStale("/project", {
      readLocalVersion: () => { throw new Error("disco indisponível"); },
    });
    assert.equal(message, null);
  });
});

test("checkHarnessVersionStale usa readLocalVersionFromDisk/readCacheFromDisk reais quando o arquivo .pi/.harness-version não existe", () => {
  // sem deps — exercita os defaults de disco contra um diretório sem .pi/.harness-version
  assert.doesNotThrow(() => {
    const message = checkHarnessVersionStale("/tmp/does-not-exist-pi-harness-version-check");
    assert.equal(message, null);
  });
});

test("o cache do version-check da lane Pi é caminho interno do harness — nunca vira violação de escopo", () => {
  // Espelha o allowlist já existente para .claude/ e .opencode/ (core/shared/lib/capture-oracle.mjs):
  // a peça escreve este arquivo dentro de .pi/ durante a run, e ele não pode ser lido como
  // arquivo tocado pela mão barata.
  assert.equal(isHarnessInternalPath(".pi/.harness-version-check-cache"), true);
  assert.equal(isHarnessInternalPath(".pi/.harness-version-check-cache.tmp"), true);
  assert.equal(isHarnessInternalPath(".pi/.harness-version-check-cache-evil"), false);
});
