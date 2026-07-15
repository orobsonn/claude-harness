#!/usr/bin/env node
/** @description Validates and submits one harness issue without invoking a shell. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SENSITIVE_VALUES = [
  "não",
  "auth/sessão",
  "pagamento/billing",
  "dados/PII",
  "segredos",
  "SQL/migração",
];
export const PRIORITY_VALUES = ["P0", "P1", "P2"];
export const SIZE_VALUES = ["S", "M", "L"];
const READY_LABEL = "harness:ready";

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} deve ser texto nao vazio`);
  }
  return value.trim();
}

function requireTaggedLines(value, field, pattern, example) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  const clean = lines.map((line) => String(line).trim()).filter(Boolean);
  if (clean.length === 0 || clean.some((line) => !pattern.test(line))) {
    throw new Error(`${field} deve conter somente linhas ${example}`);
  }
  return clean;
}

function requireDependencies(value) {
  const dependencies = requireTaggedLines(
    value ?? ["Nenhuma."],
    "dependencies",
    /^(?:#\d+|Nenhuma\.)$/,
    "#N ou Nenhuma.",
  );
  if (dependencies.includes("Nenhuma.") && dependencies.length !== 1) {
    throw new Error("dependencies: Nenhuma. deve ser usada sozinha");
  }
  return dependencies;
}

/** @description Returns a normalized issue draft or throws with the invalid field name. */
export function validateIssueDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("draft deve ser um objeto JSON");
  }
  const title = requireText(input.title, "title");
  if (!/^\[harness\] [a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(title)) {
    throw new Error("title deve seguir [harness] <slug-kebab-case>");
  }
  const sensitive = requireText(input.sensitive, "sensitive");
  const priority = requireText(input.priority, "priority");
  const size = requireText(input.size, "size");
  if (!SENSITIVE_VALUES.includes(sensitive)) throw new Error(`sensitive invalido: ${sensitive}`);
  if (!PRIORITY_VALUES.includes(priority)) throw new Error(`priority invalido: ${priority}`);
  if (!SIZE_VALUES.includes(size)) throw new Error(`size invalido: ${size}`);

  return {
    title,
    summary: requireText(input.summary, "summary"),
    user_journeys: requireTaggedLines(input.user_journeys, "user_journeys", /^#uj-\d+:\s+\S/, "#uj-N: ..."),
    acceptance_criteria: requireTaggedLines(input.acceptance_criteria, "acceptance_criteria", /^#ac-\d+\.\d+:\s+\S/, "#ac-N.M: ..."),
    scope: requireText(input.scope, "scope"),
    sensitive,
    priority,
    size,
    resolved_decisions: typeof input.resolved_decisions === "string" ? input.resolved_decisions.trim() : "",
    dependencies: requireDependencies(input.dependencies),
  };
}

/** @description Renders exactly the fields consumed from the native harness issue form. */
export function renderIssueBody(draft) {
  const sections = [
    ["Resumo + por quê", draft.summary],
    ["User journeys", draft.user_journeys.join("\n")],
    ["Critérios de aceite (testáveis e observáveis)", draft.acceptance_criteria.join("\n")],
    ["Escopo", draft.scope],
    ["Domínio sensível?", draft.sensitive],
    ["Prioridade", draft.priority],
    ["Tamanho estimado", draft.size],
  ];
  if (draft.resolved_decisions) sections.splice(4, 0, ["Decisões já resolvidas (opcional)", draft.resolved_decisions]);
  const dependencyLines = draft.dependencies.length === 1 && draft.dependencies[0] === "Nenhuma."
    ? ""
    : draft.dependencies.join("\n");
  sections.push(["Dependências", `\`\`\`harness-deps\n${dependencyLines}\n\`\`\``]);
  return `${sections.map(([heading, value]) => `### ${heading}\n\n${value}`).join("\n\n")}\n`;
}

function parseGithubRemote(remote) {
  const match = String(remote).trim().match(/github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function defaultRun(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000, ...options }).trim();
}

/** @description Verifies repository identity and label policy, then submits with body on stdin. */
export function submitIssue(draftInput, { createLabel = false, run = defaultRun } = {}) {
  const draft = validateIssueDraft(draftInput);
  const remoteRepo = parseGithubRemote(run("git", ["remote", "get-url", "origin"]));
  if (!remoteRepo) throw new Error("origin atual nao e um remoto GitHub reconhecido");
  const currentRepo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (currentRepo.toLowerCase() !== remoteRepo.toLowerCase()) {
    throw new Error(`repo atual (${currentRepo}) difere do origin (${remoteRepo})`);
  }

  const labels = JSON.parse(run("gh", ["label", "list", "--repo", currentRepo, "--json", "name", "--limit", "1000"]));
  if (!Array.isArray(labels)) throw new Error("resposta invalida ao consultar labels");
  if (!labels.some((label) => label?.name === READY_LABEL)) {
    if (!createLabel) {
      throw new Error(`label ${READY_LABEL} ausente; crie-a ou rode com --create-label`);
    }
    run("gh", ["label", "create", READY_LABEL, "--repo", currentRepo, "--color", "0E8A16", "--description", "Pronta para a pipeline autonoma do Harness"]);
  }

  return run(
    "gh",
    ["issue", "create", "--repo", currentRepo, "--title", draft.title, "--label", READY_LABEL, "--body-file", "-"],
    { input: renderIssueBody(draft) },
  );
}

function parseArgs(argv) {
  let draftPath;
  let createLabel = false;
  let validateOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--draft" && argv[i + 1]) draftPath = argv[++i];
    else if (argv[i] === "--create-label") createLabel = true;
    else if (argv[i] === "--validate-only") validateOnly = true;
    else throw new Error(`argumento inesperado: ${argv[i]}`);
  }
  if (!draftPath) throw new Error("uso: submit-issue.mjs --draft <arquivo.json> [--validate-only] [--create-label]");
  if (validateOnly && createLabel) throw new Error("--create-label nao pode ser usado com --validate-only");
  return { draftPath, createLabel, validateOnly };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { draftPath, createLabel, validateOnly } = parseArgs(process.argv.slice(2));
    const draft = JSON.parse(readFileSync(resolve(draftPath), "utf8"));
    if (validateOnly) {
      validateIssueDraft(draft);
      process.stdout.write("draft valido\n");
    } else {
      process.stdout.write(`${submitIssue(draft, { createLabel })}\n`);
    }
  } catch (error) {
    process.stderr.write(`[creating-issues] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
