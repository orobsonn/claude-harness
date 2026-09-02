/** @description Testes travados de context-files — descoberta fechada de AGENTS.md/CLAUDE.md/.pi/AGENTS.md,
 * fail-open/fail-closed e mensagens de reason. Filesystem fake em memória (sem tocar disco real). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { CONTEXT_FILE_NAMES, collectProjectContext } from "./context-files.mjs";

/**
 * @description Monta um filesystem fake em memória a partir de um mapa `path -> { content?, size?,
 * symlink? }` e devolve os três wrappers injetáveis (readFile/exists/lstat) esperados pelo lib.
 * Diretórios usados como `.git` marker entram no mapa como entradas sem `content`.
 */
function fakeFs(entries) {
  const files = new Map(Object.entries(entries));
  return {
    exists: (path) => files.has(path),
    lstat: (path) => {
      const entry = files.get(path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      if (entry.unreadableStat) throw new Error(`EACCES: ${path}`);
      const size = typeof entry.size === "number" ? entry.size : Buffer.byteLength(entry.content ?? "", "utf8");
      return { isSymbolicLink: () => Boolean(entry.symlink), size };
    },
    readFile: (path) => {
      const entry = files.get(path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      if (entry.unreadableRead) throw new Error(`EACCES: ${path}`);
      if (typeof entry.content !== "string") throw new Error(`no content: ${path}`);
      return entry.content;
    },
  };
}

const ROOT = "/repo/project";

test("context-files: AGENTS.md lido e delimitado", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "conteúdo do AGENTS" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["AGENTS.md"]);
  assert.match(result.text, /--- AGENTS\.md ---/);
  assert.match(result.text, /conteúdo do AGENTS/);
});

test("context-files: CLAUDE.md usado quando AGENTS.md ausente", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "CLAUDE.md")]: { content: "conteúdo do CLAUDE" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["CLAUDE.md"]);
  assert.match(result.text, /conteúdo do CLAUDE/);
});

test("context-files: .pi/AGENTS.md usado por último na ordem fechada", () => {
  assert.deepEqual(CONTEXT_FILE_NAMES, [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
    ".pi/AGENTS.md",
  ]);
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, ".pi/AGENTS.md")]: { content: "conteúdo do .pi" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, [".pi/AGENTS.md"]);
});

test("context-files: symlink ignorado, cai para o próximo nome", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "symlink", symlink: true },
    [join(ROOT, "CLAUDE.md")]: { content: "conteúdo real" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["CLAUDE.md"]);
  assert.doesNotMatch(result.text, /symlink/);
});

test("context-files: arquivo vazio ignorado, cai para o próximo nome", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "" },
    [join(ROOT, "CLAUDE.md")]: { content: "conteúdo real" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["CLAUDE.md"]);
});

test("context-files: arquivo de 1 MiB truncado dentro do teto com aviso", () => {
  const bigLine = "x".repeat(200) + "\n";
  const bigContent = bigLine.repeat(Math.ceil((1024 * 1024) / bigLine.length));
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: bigContent },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 32768);
  assert.match(result.text, /truncad[oa]/);
  assert.deepEqual(result.files, ["AGENTS.md"]);
});

test("context-files: aviso de truncagem cabe DENTRO do teto, mesmo sem quebra de linha", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "y".repeat(4000) },
  });
  const result = collectProjectContext(ROOT, { ...fs, maxBytes: 1024 });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 1024, "texto final nunca ultrapassa maxBytes");
  assert.match(result.text, /truncad[oa]/);
});

test("context-files: truncagem sem quebra de linha não parte caractere multibyte", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    // "é" tem 2 bytes: o corte cru cairia no meio de um deles em algum ponto do orçamento
    [join(ROOT, "AGENTS.md")]: { content: "é".repeat(4000) },
  });
  const result = collectProjectContext(ROOT, { ...fs, maxBytes: 1025 });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 1025);
  assert.doesNotMatch(result.text, /�/, "nenhum caractere de substituição no corte");
});

test("context-files: ausência total não altera o prompt (reason 'no context files')", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
  });
  const result = collectProjectContext(ROOT, fs);
  assert.deepEqual(result, { ok: false, reason: "no context files" });
});

test("context-files: cwd inválido é fail-closed sem lançar", () => {
  const fs = fakeFs({});
  assert.deepEqual(collectProjectContext("", fs), { ok: false, reason: "no context files" });
  assert.deepEqual(collectProjectContext(undefined, fs), { ok: false, reason: "no context files" });
});

test("context-files: dependências ausentes/malformadas são fail-closed sem lançar", () => {
  assert.deepEqual(collectProjectContext(ROOT, {}), { ok: false, reason: "no context files" });
  assert.deepEqual(collectProjectContext(ROOT, { readFile: () => "", exists: () => true }), {
    ok: false,
    reason: "no context files",
  });
});

test("context-files: arquivo existente porém ilegível vira reason 'context file unreadable'", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "x", unreadableRead: true },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.deepEqual(result, { ok: false, reason: "context file unreadable" });
});

test("context-files: lstat falhando em arquivo existente também vira 'context file unreadable'", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "x", unreadableStat: true },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.deepEqual(result, { ok: false, reason: "context file unreadable" });
});

test("context-files: maxBytes <= 0 é 'context budget exhausted'", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "conteúdo" },
  });
  assert.deepEqual(collectProjectContext(ROOT, { ...fs, maxBytes: 0 }), {
    ok: false,
    reason: "context budget exhausted",
  });
  assert.deepEqual(collectProjectContext(ROOT, { ...fs, maxBytes: -5 }), {
    ok: false,
    reason: "context budget exhausted",
  });
});

test("context-files: orçamento pequeno demais pro cabeçalho do primeiro arquivo é 'context budget exhausted'", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "conteúdo qualquer" },
  });
  const result = collectProjectContext(ROOT, { ...fs, maxBytes: 4 });
  assert.deepEqual(result, { ok: false, reason: "context budget exhausted" });
});

test("context-files: um arquivo por diretório — AGENTS.md sombreia CLAUDE.md e .pi/AGENTS.md", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "um" },
    [join(ROOT, "CLAUDE.md")]: { content: "dois" },
    [join(ROOT, ".pi/AGENTS.md")]: { content: "tres" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["AGENTS.md"]);
  assert.doesNotMatch(result.text, /dois|tres/);
});

test("context-files: AGENTS.override.md sombreia AGENTS.md no mesmo diretório", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.override.md")]: { content: "override vence" },
    [join(ROOT, "AGENTS.md")]: { content: "sombreado" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["AGENTS.override.md"]);
  assert.doesNotMatch(result.text, /sombreado/);
});

test("context-files: um arquivo por diretório, ancestral antes da raiz do projeto", () => {
  const sub = join(ROOT, "app");
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "camada generica" },
    [join(sub, "CLAUDE.md")]: { content: "camada especifica" },
  });
  const result = collectProjectContext(sub, fs);
  assert.equal(result.ok, true);
  // o mais específico vem por último, como no layering nativo do Pi
  assert.deepEqual(result.files, ["../AGENTS.md", "CLAUDE.md"]);
  assert.ok(result.text.indexOf("camada generica") < result.text.indexOf("camada especifica"));
});

test("context-files: sobe no máximo um nível, até a raiz do repositório git", () => {
  const sub = join(ROOT, "app");
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "raiz do repo" },
  });
  const result = collectProjectContext(sub, fs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ["../AGENTS.md"]);
});

test("context-files: cwd já é a raiz git — não sobe nível nenhum", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    // arquivo um nível acima da raiz git não deve ser encontrado
    ["/repo/AGENTS.md"]: { content: "fora do repo" },
  });
  const result = collectProjectContext(ROOT, fs);
  assert.deepEqual(result, { ok: false, reason: "no context files" });
});

test("context-files: sem raiz git localizável, nunca sobe nível", () => {
  const fs = fakeFs({
    ["/no-git-parent/AGENTS.md"]: { content: "não deve ser achado" },
  });
  const result = collectProjectContext("/no-git-parent/project", fs);
  assert.deepEqual(result, { ok: false, reason: "no context files" });
});

test("context-files: coleta é pura — chamada dupla devolve exatamente o mesmo resultado", () => {
  const fs = fakeFs({
    [join(ROOT, ".git")]: {},
    [join(ROOT, "AGENTS.md")]: { content: "conteúdo" },
  });
  const first = collectProjectContext(ROOT, fs);
  const second = collectProjectContext(ROOT, fs);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first, second);
});
