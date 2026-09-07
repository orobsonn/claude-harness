/**
 * @description Contexto de projeto sob controle da lane Pi — descoberta FECHADA de arquivos de
 * contexto (AGENTS.md, CLAUDE.md, .pi/AGENTS.md), sem reabrir descoberta arbitrária de recursos.
 * O launcher (core/pi/bin/pi-harness.mjs) passa `--no-context-files` justamente para desligar a
 * descoberta nativa do Pi; esta peça devolve só esta lista fechada de nomes, por conta própria.
 * Lógica pura e host-agnóstica: toda I/O (readFile/exists/lstat) é injetada pelo chamador — o
 * adaptador (core/pi/extensions/harness-context-files.ts) injeta wrappers de `node:fs`. Nunca
 * lança; qualquer falha vira um Result {ok:false,reason}.
 */

import { dirname, join, resolve } from "node:path";

/**
 * @description Ordem fechada de nomes de arquivo de contexto — nenhum outro nome é considerado.
 * Os cinco primeiros e a ordem entre eles são os do próprio Pi (`loadContextFileFromDir` em
 * dist/core/resource-loader.js): `AGENTS.override.md` existe justamente para SOMBREAR os demais
 * no mesmo diretório, e as variantes `.MD` importam em filesystem case-sensitive. `.pi/AGENTS.md`
 * é o slot extra da lane (o Pi não o conhece) e por isso fica por último.
 */
export const CONTEXT_FILE_NAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  ".pi/AGENTS.md",
]);

const DEFAULT_MAX_BYTES = 32768;
// Trava defensiva: no máximo um arquivo POR DIRETÓRIO e no máximo dois diretórios candidatos
// (raiz do projeto + um nível acima), então este teto nunca deveria ser atingido na prática.
const MAX_FILES = 2;
// Teto individual de sanidade — bem acima do teto total (32 KiB). Protege contra ler um arquivo
// absurdamente grande antes mesmo de truncar; um arquivo de 1 MiB, por exemplo, passa por este
// teto sem problema e é truncado normalmente dentro do teto TOTAL de 32 KiB.
const INDIVIDUAL_HARD_CAP_BYTES = 8 * 1024 * 1024;
const TRUNCATION_NOTICE = "\n\n[aviso: conteúdo de contexto de projeto truncado — orçamento de 32 KiB esgotado]";
const TRUNCATION_NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");

/** @param {(path: string) => boolean} exists @param {string} path */
function safeExists(exists, path) {
  try {
    return Boolean(exists(path));
  } catch {
    return false;
  }
}

/** @param {(path: string) => {isSymbolicLink: () => boolean, size: number}} lstat @param {string} path */
function safeLstat(lstat, path) {
  try {
    return lstat(path);
  } catch {
    return null;
  }
}

/**
 * @description Acha a raiz do repositório git subindo a partir de `startDir`. Devolve null quando
 * nenhum `.git` é encontrado antes da raiz do filesystem — nesse caso o chamador não sobe nível
 * nenhum (sem raiz conhecida, não há como saber onde parar de subir).
 * @param {string} startDir
 * @param {(path: string) => boolean} exists
 * @returns {string | null}
 */
function findGitRoot(startDir, exists) {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    if (safeExists(exists, join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * @description Diretórios candidatos em ORDEM DE CAMADA — do mais genérico para o mais
 * específico, igual ao Pi (`loadProjectContextFiles` faz `unshift` dos ancestrais, deixando o
 * `cwd` por último para que o contexto mais específico venha depois e prevaleça): no máximo um
 * nível acima e, por fim, a raiz do projeto (`cwd`). Só sobe quando esse nível acima ainda está
 * dentro da raiz do repositório git (isto é, quando `cwd` não é a própria raiz do repositório).
 * Sem raiz git localizável, nunca sobe.
 * @param {string} cwd
 * @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
function candidateDirs(cwd, exists) {
  const gitRoot = findGitRoot(cwd, exists);
  if (gitRoot === null) return [cwd];
  if (resolve(cwd) === resolve(gitRoot)) return [cwd];
  const parent = dirname(cwd);
  if (parent === cwd) return [cwd];
  return [parent, cwd];
}

/** @description Rótulo relativo a `cwd` usado no atributo `files` do prompt injetado. */
function relativeLabel(dir, cwd, name) {
  return dir === cwd ? name : `../${name}`;
}

/**
 * @description Corta `text` no maior prefixo de bytes UTF-8 que caiba em `budgetBytes`,
 * recuando até a última quebra de linha para não partir uma linha ao meio. Nunca lança.
 * @param {string} text
 * @param {number} budgetBytes
 * @returns {string}
 */
function truncateAtLineBoundary(text, budgetBytes) {
  if (budgetBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budgetBytes) return text;
  let slice = buf.subarray(0, budgetBytes);
  const lastNewline = slice.lastIndexOf(0x0a);
  // Sem quebra de linha no orçamento o corte cai no meio de um caractere: descartar a sequência
  // UTF-8 incompleta evita o U+FFFD (3 bytes) que estouraria o orçamento em vez de respeitá-lo.
  slice = lastNewline > 0 ? slice.subarray(0, lastNewline) : dropIncompleteUtf8(slice);
  return slice.toString("utf8");
}

/**
 * @description Recua o fim de `buf` até o último caractere UTF-8 COMPLETO. Nunca lança; devolve
 * um buffer vazio quando não há nenhum caractere completo.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function dropIncompleteUtf8(buf) {
  let lead = buf.length - 1;
  let continuation = 0;
  while (lead >= 0 && (buf[lead] & 0xc0) === 0x80 && continuation < 3) {
    lead -= 1;
    continuation += 1;
  }
  if (lead < 0) return buf.subarray(0, 0);
  const byte = buf[lead];
  let needed;
  if ((byte & 0x80) === 0) needed = 1;
  else if ((byte & 0xe0) === 0xc0) needed = 2;
  else if ((byte & 0xf0) === 0xe0) needed = 3;
  else if ((byte & 0xf8) === 0xf0) needed = 4;
  else return buf.subarray(0, lead); // byte inválido: corta antes dele
  return continuation + 1 === needed ? buf : buf.subarray(0, lead);
}

/**
 * @description Concatena os arquivos coletados (em ordem) respeitando um teto TOTAL em bytes,
 * truncando o último arquivo que não couber inteiro no limite de linha e anexando um aviso
 * literal de truncagem. O aviso é reservado DENTRO do teto — o texto final nunca ultrapassa
 * `maxBytes`. Devolve `parts.length === 0` quando o orçamento não coube nem o cabeçalho (ou nem
 * uma linha) do primeiro arquivo — sinal de orçamento esgotado para o chamador.
 * @param {{relPath: string, content: string}[]} collected
 * @param {number} maxBytes
 * @returns {{parts: string[], files: string[], truncated: boolean}}
 */
function concatWithBudget(collected, maxBytes) {
  const parts = [];
  const files = [];
  let usedBytes = 0;
  let truncated = false;

  for (const item of collected) {
    const header = `--- ${item.relPath} ---\n`;
    // O separador entre blocos ("\n\n", aplicado no join) também consome orçamento.
    const headerBytes = Buffer.byteLength(header, "utf8") + (parts.length === 0 ? 0 : 2);
    if (usedBytes + headerBytes >= maxBytes) {
      truncated = true;
      break;
    }
    usedBytes += headerBytes;

    let body = item.content;
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (usedBytes + bodyBytes > maxBytes) {
      // O aviso de truncagem entra no MESMO orçamento — reservá-lo aqui é o que impede o texto
      // final de estourar `maxBytes` justamente no caso em que ele deveria ser respeitado.
      body = truncateAtLineBoundary(body, maxBytes - usedBytes - TRUNCATION_NOTICE_BYTES);
      truncated = true;
      if (body.length === 0) {
        // Nem uma linha coube: não vale emitir um cabeçalho órfão.
        usedBytes -= headerBytes;
        break;
      }
    }
    usedBytes += Buffer.byteLength(body, "utf8");

    parts.push(header + body);
    files.push(item.relPath);
    if (truncated) break;
  }

  return { parts, files, truncated };
}

/**
 * @description Coleta os arquivos de contexto do projeto — lista fechada de nomes
 * (CONTEXT_FILE_NAMES), UM por diretório, em no máximo um nível acima da raiz do projeto (até a
 * raiz do repositório git) e na própria raiz, nesta ordem de camada (o mais específico por
 * último, como no Pi). Ignora symlink (lstat), arquivo vazio e arquivo maior que o teto
 * individual de sanidade. Concatena com um teto TOTAL de `maxBytes` (default 32 KiB), truncando
 * no limite de linha e anexando um aviso literal de truncagem — que cabe dentro do teto.
 * Nunca lança.
 * @param {string} cwd
 * @param {{readFile: (path: string) => string, exists: (path: string) => boolean,
 *   lstat: (path: string) => {isSymbolicLink: () => boolean, size: number}, maxBytes?: number}} deps
 * @returns {{ok: true, text: string, files: string[]} | {ok: false, reason: string}}
 */
export function collectProjectContext(cwd, deps = {}) {
  try {
    const { readFile, exists, lstat, maxBytes = DEFAULT_MAX_BYTES } = deps;
    if (typeof cwd !== "string" || cwd.length === 0) return { ok: false, reason: "no context files" };
    if (typeof readFile !== "function" || typeof exists !== "function" || typeof lstat !== "function") {
      return { ok: false, reason: "no context files" };
    }
    if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      return { ok: false, reason: "context budget exhausted" };
    }

    const dirs = candidateDirs(cwd, exists);
    const collected = [];
    let unreadableSeen = false;

    outer: for (const dir of dirs) {
      // UM arquivo por diretório, primeiro nome que casar — mesma regra do Pi
      // (`loadContextFileFromDir`): `AGENTS.override.md` sombreia `AGENTS.md`, que sombreia
      // `CLAUDE.md` no MESMO diretório. Sem isso, um projeto com AGENTS.md e CLAUDE.md na raiz
      // injetaria as duas camadas e gastaria o orçamento inteiro sem nunca chegar ao nível acima.
      for (const name of CONTEXT_FILE_NAMES) {
        if (collected.length >= MAX_FILES) break outer;

        const fullPath = join(dir, name);
        if (!safeExists(exists, fullPath)) continue;

        const stat = safeLstat(lstat, fullPath);
        if (!stat) {
          // exists() disse que sim, lstat falhou: arquivo real mas inacessível — não "ausente".
          unreadableSeen = true;
          continue;
        }
        if (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()) continue;
        if (typeof stat.size === "number") {
          if (stat.size === 0) continue;
          if (stat.size > INDIVIDUAL_HARD_CAP_BYTES) continue;
        }

        let content;
        try {
          content = readFile(fullPath);
        } catch {
          unreadableSeen = true;
          continue;
        }
        if (typeof content !== "string" || content.length === 0) continue;

        collected.push({ relPath: relativeLabel(dir, cwd, name), content });
        continue outer; // este diretório já contribuiu com o seu único arquivo
      }
    }

    if (collected.length === 0) {
      return unreadableSeen ? { ok: false, reason: "context file unreadable" } : { ok: false, reason: "no context files" };
    }

    const { parts, files, truncated } = concatWithBudget(collected, maxBytes);
    if (parts.length === 0) return { ok: false, reason: "context budget exhausted" };

    let text = parts.join("\n\n");
    if (truncated) text += TRUNCATION_NOTICE;
    return { ok: true, text, files };
  } catch {
    return { ok: false, reason: "no context files" };
  }
}

export default { CONTEXT_FILE_NAMES, collectProjectContext };
