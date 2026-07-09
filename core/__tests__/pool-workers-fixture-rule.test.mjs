/**
 * @description Transcreve as asserções pinadas sobre a nova regra de fixtures
 * em testes @cloudflare/vitest-pool-workers (sem node:fs, via import ?raw) —
 * cobrindo core/agents/test-author.md, core/rules/testing-unit.md e a entrada
 * correspondente em CHANGELOG.md. Estas asserções devem estar VERMELHAS no
 * HEAD atual: as seções ainda não existem nos docs e a subseção Added do
 * Unreleased ainda está vazia.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_AUTHOR_PATH = resolve(__dirname, "../agents/test-author.md");
const TESTING_UNIT_PATH = resolve(__dirname, "../rules/testing-unit.md");
const CHANGELOG_PATH = resolve(__dirname, "../../CHANGELOG.md");

const NEW_SECTION_HEADING = "### Fixtures em testes @cloudflare/vitest-pool-workers (sem node:fs)";
const STEP3_HEADING = "### 3. Transcreva para código de teste";
const STEP4_HEADING = "### 4. Escreva o teste e as fixtures enumeradas";
const ANTI_SCOPE_HEADING = "## Anti-escopo-creep (blindado)";

/**
 * @description Determina o nível de um heading markdown (número de `#` líderes).
 * @param {string} trimmedLine linha já com trim() aplicado.
 * @returns {number} nível do heading, ou Infinity se não for heading.
 */
function headingLevel(trimmedLine) {
  const match = trimmedLine.match(/^(#+)\s/);
  return match ? match[1].length : Number.POSITIVE_INFINITY;
}

/**
 * @description Fatia o texto do heading cuja linha (trim()) é EXATAMENTE
 * igual a exactHeadingLine até o próximo heading de nível igual ou superior
 * (exclusive). Usa igualdade de linha completa — nunca substring — para não
 * capturar um heading homônimo parcial (ex.: "### Fixtures" pré-existente).
 * @param {string} content conteúdo completo do arquivo.
 * @param {string} exactHeadingLine linha de heading exata a localizar.
 * @returns {string} texto da seção, ou string vazia se o heading não existir.
 */
function sliceSection(content, exactHeadingLine) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === exactHeadingLine);
  if (startIdx === -1) return "";
  const startLevel = headingLevel(lines[startIdx].trim());
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#") && headingLevel(trimmed) <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * @description Lista, na ordem do documento, todas as linhas de heading
 * markdown (trim() começa com "#").
 * @param {string} content conteúdo completo do arquivo.
 * @returns {string[]} linhas de heading, trimmed, em ordem.
 */
function headings(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"));
}

test("test-author.md: seção da nova regra co-localiza qualificador, proibição node:fs/readFileSync/readFile, ?raw e carve-out concreto (core/__tests__/ + passo 6)", () => {
  const content = readFileSync(TEST_AUTHOR_PATH, "utf8");
  const section = sliceSection(content, NEW_SECTION_HEADING);
  assert.notEqual(section, "", "heading da nova seção não encontrado em test-author.md");

  assert.ok(
    section.includes("@cloudflare/vitest-pool-workers"),
    "seção não menciona o qualificador @cloudflare/vitest-pool-workers"
  );
  assert.ok(
    section.includes("node:fs"),
    "seção não proíbe node:fs"
  );
  assert.ok(
    section.includes("readFileSync"),
    "seção não proíbe readFileSync"
  );
  assert.ok(
    /\breadFile\b(?!Sync)/.test(section),
    "seção não proíbe readFile explicitamente, além de readFileSync"
  );
  assert.ok(
    section.includes("?raw"),
    "seção não prescreve o import ?raw"
  );
  assert.ok(
    section.includes("node:test"),
    "seção não declara o carve-out genérico node:test"
  );
  assert.ok(
    section.includes("core/__tests__/"),
    "seção não cita o exemplar concreto core/__tests__/"
  );
  assert.ok(
    /§6|passo 6|step 6/i.test(section),
    "seção não referencia o passo 6 como exemplar do carve-out"
  );
});

test("test-author.md: seção da nova regra declara que ?raw devolve string/texto bruto (não objeto parseado) e que JSON.parse é necessário", () => {
  const content = readFileSync(TEST_AUTHOR_PATH, "utf8");
  const section = sliceSection(content, NEW_SECTION_HEADING);
  assert.notEqual(section, "", "heading da nova seção não encontrado em test-author.md");

  assert.ok(section.includes("?raw"), "seção não menciona ?raw");
  assert.ok(
    /\bstring\b|\btexto\b/i.test(section),
    "seção não declara que ?raw devolve string/texto bruto"
  );
  assert.ok(
    /n(ã|a)o[^\n]{0,60}objeto parseado|objeto parseado[^\n]{0,60}n(ã|a)o/i.test(section),
    "seção não nega explicitamente que ?raw devolva um objeto parseado"
  );
  assert.ok(
    section.includes("JSON.parse"),
    "seção não menciona JSON.parse como necessário para obter o objeto"
  );
});

test("test-author.md: heading da nova seção fica posicionado entre o step 3 e o step 4 (índice de heading, não número de linha)", () => {
  const content = readFileSync(TEST_AUTHOR_PATH, "utf8");
  const headingList = headings(content);

  const idxStep3 = headingList.indexOf(STEP3_HEADING);
  const idxNova = headingList.indexOf(NEW_SECTION_HEADING);
  const idxStep4 = headingList.indexOf(STEP4_HEADING);

  assert.notEqual(idxStep3, -1, "heading do step 3 não encontrado em test-author.md");
  assert.notEqual(idxNova, -1, "heading da nova seção não encontrado em test-author.md");
  assert.notEqual(idxStep4, -1, "heading do step 4 não encontrado em test-author.md");

  assert.ok(
    idxStep3 < idxNova,
    "heading da nova seção não está posicionado depois do step 3"
  );
  assert.ok(
    idxNova < idxStep4,
    "heading da nova seção não está posicionado antes do step 4"
  );
});

test("testing-unit.md: seção da nova regra (mesmo heading exato) co-localiza qualificador, proibição node:fs/readFileSync/readFile, ?raw e carve-out concreto (core/__tests__/ + passo 6)", () => {
  const content = readFileSync(TESTING_UNIT_PATH, "utf8");
  const section = sliceSection(content, NEW_SECTION_HEADING);
  assert.notEqual(section, "", "heading da nova seção não encontrado em testing-unit.md");

  assert.ok(
    section.includes("@cloudflare/vitest-pool-workers"),
    "seção não menciona o qualificador @cloudflare/vitest-pool-workers"
  );
  assert.ok(
    section.includes("node:fs"),
    "seção não proíbe node:fs"
  );
  assert.ok(
    section.includes("readFileSync"),
    "seção não proíbe readFileSync"
  );
  assert.ok(
    /\breadFile\b(?!Sync)/.test(section),
    "seção não proíbe readFile explicitamente, além de readFileSync"
  );
  assert.ok(
    section.includes("?raw"),
    "seção não prescreve o import ?raw"
  );
  assert.ok(
    section.includes("node:test"),
    "seção não declara o carve-out genérico node:test"
  );
  assert.ok(
    section.includes("core/__tests__/"),
    "seção não cita o exemplar concreto core/__tests__/"
  );
  assert.ok(
    /§6|passo 6|step 6/i.test(section),
    "seção não referencia o passo 6 como exemplar do carve-out"
  );
});

test("testing-unit.md: seção da nova regra declara que ?raw devolve string/texto bruto (não objeto parseado) e que JSON.parse é necessário", () => {
  const content = readFileSync(TESTING_UNIT_PATH, "utf8");
  const section = sliceSection(content, NEW_SECTION_HEADING);
  assert.notEqual(section, "", "heading da nova seção não encontrado em testing-unit.md");

  assert.ok(section.includes("?raw"), "seção não menciona ?raw");
  assert.ok(
    /\bstring\b|\btexto\b/i.test(section),
    "seção não declara que ?raw devolve string/texto bruto"
  );
  assert.ok(
    /n(ã|a)o[^\n]{0,60}objeto parseado|objeto parseado[^\n]{0,60}n(ã|a)o/i.test(section),
    "seção não nega explicitamente que ?raw devolva um objeto parseado"
  );
  assert.ok(
    section.includes("JSON.parse"),
    "seção não menciona JSON.parse como necessário para obter o objeto"
  );
});

test("test-author.md: linha da tabela anti-escopo-creep que permite builtins (fs) carrega referência normativa explícita à nova regra", () => {
  const content = readFileSync(TEST_AUTHOR_PATH, "utf8");
  const section = sliceSection(content, ANTI_SCOPE_HEADING);
  assert.notEqual(section, "", "heading da tabela anti-escopo-creep não encontrado em test-author.md");

  const builtinsLine = section
    .split("\n")
    .find((line) => line.includes("builtins") && line.includes("fs"));

  assert.ok(builtinsLine, "linha da tabela que permite builtins (fs) não encontrada");
  assert.ok(
    builtinsLine.includes("@cloudflare/vitest-pool-workers") ||
      builtinsLine.includes(NEW_SECTION_HEADING),
    "linha de builtins não referencia normativamente a nova regra @cloudflare/vitest-pool-workers"
  );
});

test("CHANGELOG.md: subseção Added do Unreleased contém entrada mencionando @cloudflare/vitest-pool-workers e ?raw", () => {
  const content = readFileSync(CHANGELOG_PATH, "utf8");
  const unreleasedSection = sliceSection(content, "## [Unreleased]");
  assert.notEqual(unreleasedSection, "", "seção ## [Unreleased] não encontrada em CHANGELOG.md");

  const addedSection = sliceSection(unreleasedSection, "### Added");
  assert.notEqual(addedSection, "", "subseção ### Added não encontrada dentro de ## [Unreleased]");

  assert.ok(
    addedSection.includes("@cloudflare/vitest-pool-workers"),
    "subseção Added do Unreleased não menciona @cloudflare/vitest-pool-workers"
  );
  assert.ok(
    addedSection.includes("?raw"),
    "subseção Added do Unreleased não menciona ?raw"
  );
});
