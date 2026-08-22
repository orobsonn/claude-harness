/**
 * @description Interactive wizard behind `npx claude-harness setup-vps` / `node .../cli.mjs setup-vps`.
 * Runs ON the VPS, from inside the project you want to onboard, as the user that owns the Orca
 * runtime (`orca`) — NEVER as root.
 *
 * What it installs is the CURRENT design: **Orca dispatches, the repo's vendored `.claude/` harness
 * executes**. Concretely, two artifacts and nothing else:
 *   1. a per-project config JSON (`~/.config/claude-harness/projects/<slug>.json`) — the format is
 *      `core/orca/project.example.json`;
 *   2. one fenced crontab line running `core/orca/select-and-dispatch.mjs --config <that JSON>`.
 *
 * It NO LONGER installs the retired VPS cron engine (`core/vps/install-crons.mjs`: Cron A, the review
 * cron, drain, reaper, Telegram notify). That engine is retired — see `core/vps/DEPRECATED.md` for
 * the measured reasons and the verification runbook that must precede deleting it. Notifications are
 * no longer a wizard concern either: Orca runs are visible from desktop and phone, which is what the
 * Telegram plumbing existed to simulate.
 *
 * The one thing this wizard CANNOT do for you is the PR-review + conditional-merge step: that is a
 * scheduled Orca automation, configured in Orca, not code in this repo. The wizard prints its exact
 * merge criteria at the end so the operator sets it up with the same contract every time.
 *
 * STABLE-ENGINE contract (critical): the crontab line points at
 * `<engineDir>/core/orca/select-and-dispatch.mjs`, so the harness MUST live at a durable path.
 * Resolution:
 *   1. `deps.localEngineDir` — this script's own harness clone, when it actually contains
 *      core/orca. Stable.
 *   2. else `deps.stableEngineDir` (~/.claude/harness-core) — cloned once via `deps.cloneEngine` if
 *      core/orca is missing there (e.g. the wizard is running from the ephemeral npx cache).
 *      Never runs the selector from the npx cache.
 *
 * Every side-effecting seam is injectable for hermetic testing. Node builtins only, zero deps.
 */
import { join, basename } from "node:path";

export const CRON_FENCE_PREFIX = "harness-orca";

/** Where the AppImage install puts the binary. It is never on PATH — hence the cron line carries it. */
export const DEFAULT_ORCA_BIN = "/opt/orca/orca-linux.AppImage";

/**
 * @description Parses `owner`/`repo` from a git remote URL (ssh `git@host:owner/repo.git`, https
 * `https://host/owner/repo(.git)`, or trailing slash). Returns empty strings when unparseable.
 * @param {string} url
 * @returns {{ owner: string, repo: string }}
 */
export function parseGitRemote(url) {
  const m = String(url ?? "").trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
}

/**
 * @description Self-explanatory guide (pt-br) shown before the Orca questions: where to get the repo
 * id, and why the concurrency ceiling is global rather than per-project.
 * @returns {string}
 */
export function orcaGuide() {
  return [
    "",
    "──────────────────────────────────────────────────────────────",
    " Orca — a ADE oficial do harness (https://onorca.dev)",
    "──────────────────────────────────────────────────────────────",
    "",
    " O Orca despacha; o .claude/ vendorado deste repo executa.",
    " Downloads: https://onorca.dev · https://github.com/stablyai/orca/releases",
    "",
    " 1) id DO REPO NO ORCA",
    "    • Registre o repositório no Orca (desktop ou CLI) e rode:",
    "        orca repo list --json",
    '    • Copie o campo "id" do repo — é o valor pedido abaixo.',
    "",
    " 2) TETO DE CONCORRÊNCIA (globalMaxWorking)",
    "    • É um teto DA MÁQUINA, não do projeto: o selector conta os worktrees",
    "      'working' de TODA a VPS via `orca worktree ps --json`.",
    "    • Todos os projetos precisam do MESMO valor. Validado em 4 agentes",
    "      Claude simultâneos numa VPS de 2 vCPU / 8 GB.",
    "",
    " 3) MODO CANÁRIO (titleIncludes)",
    "    • Sem filtro, a issue escolhida é a `harness:ready` aberta MAIS ANTIGA —",
    "      num backlog real isso costuma ser uma tarefa de anos atrás, não a que",
    "      você quer observar primeiro. Comece com algo como [canary].",
    "",
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

/**
 * @description Builds the project config object written to disk. Mirrors
 * `core/orca/project.example.json` — the same shape `normalizeConfig` validates at every tick.
 * @param {object} a
 * @returns {object}
 */
export function buildProjectConfig(a) {
  return {
    project: a.project,
    ghRepo: `${a.owner}/${a.repo}`,
    orcaRepoId: a.orcaRepoId,
    clonePath: a.clonePath,
    baseBranch: a.baseBranch,
    agent: a.agent,
    globalMaxWorking: a.globalMaxWorking,
    titleIncludes: a.titleIncludes || null,
    prompt: a.prompt,
  };
}

/**
 * @description Rejects a value that cannot appear literally in a crontab line. `%` is the killer —
 * cron treats it as a newline and would silently truncate the command; a newline or a comment marker
 * would let a config path inject extra crontab content. WHITESPACE is refused for the same reason and
 * is the likeliest of all: the line is unquoted, so a binary at `~/Applications/Orca App/orca` splits
 * into two argv entries and the tick dies at `sh: orca: not found` — a queue that never dispatches,
 * which is the exact failure this wizard exists to avoid.
 * @param {string} value
 * @param {string} field
 * @returns {string}
 */
export function assertCronSafe(value, field) {
  const v = String(value ?? "");
  if (v === "" || /[%\n\r#\s]/.test(v)) {
    throw new Error(`setup-vps: "${field}" não pode ficar vazio nem conter espaço, % \\n ou # (quebraria a linha do cron)`);
  }
  return v;
}

/**
 * @description Renders the fenced crontab block for one project. Fenced with literal
 * `# >>> harness-orca:<slug> >>>` / `# <<< harness-orca:<slug> <<<` lines so `upsertCronBlock` can
 * replace it idempotently and an operator can delete it by hand without guessing. No trailing newline.
 *
 * `ORCA_BIN` is part of the LINE, not an optional nicety: the selector falls back to `orca` on PATH,
 * the AppImage install is NOT on PATH (and the shim that sometimes is, is broken), and cron inherits a
 * minimal environment. Without it every tick dies before selecting anything and logs
 * `skip: could not read 'orca worktree ps --json'` — indistinguishable from "Orca is down". A wizard
 * that writes a queue which never dispatches is worse than one that refuses to write it.
 * @param {{project:string,orcaBin:string,nodeBin:string,selectorPath:string,configPath:string,logPath:string,intervalMinutes:number}} args
 * @returns {string}
 */
export function renderCronBlock({ project, orcaBin, nodeBin, selectorPath, configPath, logPath, intervalMinutes }) {
  const slug = assertCronSafe(project, "project");
  assertCronSafe(orcaBin, "orcaBin");
  assertCronSafe(nodeBin, "nodeBin");
  assertCronSafe(selectorPath, "selectorPath");
  assertCronSafe(configPath, "configPath");
  assertCronSafe(logPath, "logPath");
  const minutes = Number(intervalMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
    throw new Error('setup-vps: "intervalMinutes" precisa ser um inteiro entre 1 e 59');
  }
  const line = `*/${minutes} * * * * ORCA_BIN=${orcaBin} ${nodeBin} ${selectorPath} --config ${configPath} >> ${logPath} 2>&1`;
  return [`# >>> ${CRON_FENCE_PREFIX}:${slug} >>>`, line, `# <<< ${CRON_FENCE_PREFIX}:${slug} <<<`].join("\n");
}

/**
 * @description PURE idempotent upsert of a fenced block into crontab text: removes any existing
 * block with the same fence, then appends the new one. Every other line — including OTHER projects'
 * blocks and the operator's own unrelated crons — is preserved byte-for-byte.
 * @param {string} crontabText
 * @param {string} marker e.g. "harness-orca:oraculo-app"
 * @param {string} blockText
 * @returns {string}
 */
export function upsertCronBlock(crontabText, marker, blockText) {
  const opener = `# >>> ${marker} >>>`;
  const closer = `# <<< ${marker} <<<`;
  const lines = String(crontabText ?? "").split("\n");
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.trim() === opener) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line.trim() === closer) inside = false;
      continue;
    }
    kept.push(line);
  }
  const base = kept.join("\n").replace(/\n+$/, "");
  return `${base ? `${base}\n` : ""}${blockText}\n`;
}

/**
 * @description The PR-review + conditional-merge contract, printed at the end. It is a scheduled
 * ORCA automation, not code — but its criteria must not drift, so the wizard states them verbatim.
 * @returns {string}
 */
export function reviewAutomationGuide() {
  return [
    "",
    "──────────────────────────────────────────────────────────────",
    " Passo manual restante: automação de revisão de PR no Orca",
    "──────────────────────────────────────────────────────────────",
    "",
    " Crie uma automação AGENDADA no Orca para este repo. Ela só merja se:",
    "   • o veredito próprio da revisão for: merjar;",
    "   • NENHUM achado ARMADO de severidade alta;",
    "   • CI concluído em SUCCESS;",
    "   • sem conflito;",
    "   • e o merge passar --match-head-commit <sha> (obrigatório).",
    "",
    " IMPORTANTE — o entry-gate do harness recusa alvo ambíguo em `gh pr merge`:",
    "   o comando de merge NÃO pode passar -R/--repo (nem --auto). Rode dentro do",
    "   checkout do repo alvo e passe só o número do PR.",
    "",
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

/**
 * @description Trims an answer; throws a clear, field-named error when a required value is empty.
 * @param {string} value
 * @param {string} field
 * @returns {string}
 */
function required(value, field) {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`setup-vps: "${field}" é obrigatório — execute de novo e preencha esse campo.`);
  return v;
}

/**
 * @description Resolves the STABLE path to `core/orca/select-and-dispatch.mjs`: this script's own
 * clone when valid, else a stable clone dir (cloned once if missing). See the module header.
 * @param {object} deps
 * @param {(t: string) => void} out
 * @returns {string} selectorPath
 */
function resolveSelectorPath(deps, out) {
  const rel = ["core", "orca", "select-and-dispatch.mjs"];
  let engineDir = deps.localEngineDir || null;
  if (!engineDir || !deps.exists(join(engineDir, ...rel))) {
    engineDir = deps.stableEngineDir;
    if (!deps.exists(join(engineDir, ...rel))) {
      out(`\nHarness (core/orca) não está aqui — clonando uma vez em ${engineDir}...`);
      deps.cloneEngine(engineDir);
    }
  }
  const selectorPath = join(engineDir, ...rel);
  if (!deps.exists(selectorPath)) {
    throw new Error(
      `setup-vps: não consegui disponibilizar o selector em ${selectorPath}. ` +
        `Clone o harness num path estável (git clone https://github.com/orobsonn/claude-harness.git <destino>) ` +
        `e rode de dentro dele: node <destino>/core/claude-code/skills/initializing-projects/references/cli.mjs setup-vps`
    );
  }
  return selectorPath;
}

/**
 * @description Runs the interactive VPS setup wizard. All seams injected for testability.
 * @param {object} deps
 * @param {(question: string) => Promise<string>} deps.ask
 * @param {(text: string) => void} deps.out
 * @param {Record<string,string|undefined>} deps.env
 * @param {string} deps.cwd - current working directory (the project being onboarded).
 * @param {(dir: string) => string} deps.gitRemote - `git -C <dir> remote get-url origin` ('' on failure).
 * @param {string|null} deps.localEngineDir - this script's harness clone root, or null if not a clone.
 * @param {string} deps.stableEngineDir - fallback stable harness dir (~/.claude/harness-core).
 * @param {(dir: string) => void} deps.cloneEngine - clones the harness (pinned) into dir.
 * @param {string} deps.nodeBin - absolute node binary for the crontab line.
 * @param {(path: string) => boolean} deps.exists
 * @param {(dir: string) => void} deps.ensureDir
 * @param {(path: string, json: object) => void} deps.writeJson
 * @param {() => string} deps.readCrontab - current user's crontab text ('' when none).
 * @param {(text: string) => void} deps.writeCrontab
 * @param {() => string} [deps.whoami] - current user, for the never-as-root guard.
 * @returns {Promise<{ project: string, configPath: string, selectorPath: string, config: object, cronBlock: string }>}
 */
export async function runSetupVps(deps) {
  const {
    ask, out, env, cwd, gitRemote, nodeBin,
    ensureDir, writeJson, readCrontab, writeCrontab, whoami = () => "",
  } = deps;

  // The selector is a USER cron. Running the engine as root — with every client's deploy token in
  // the ambient environment — is one of the measured reasons the previous design was retired.
  if (whoami() === "root") {
    throw new Error(
      "setup-vps: não rode como root. O selector é cron do usuário que roda o Orca (ex.: `orca`) — " +
        "isso é o que faz a credencial escopada por projeto valer alguma coisa."
    );
  }

  const selectorPath = resolveSelectorPath(deps, out);

  out(
    [
      "",
      "=== claude-harness setup-vps — entrega autônoma via Orca ===",
      "Orca despacha, o .claude/ vendorado deste repo executa.",
      "Vou inferir o máximo do projeto atual; Enter aceita o valor entre [colchetes].",
      "",
    ].join("\n")
  );

  const homeDir = required((await ask(`Home dir [${env.HOME ?? ""}]: `)) || env.HOME, "home-dir");
  const projectRoot = required((await ask(`Path do projeto [${cwd}]: `)) || cwd, "project-root");
  const projectDefault = basename(projectRoot);
  const project = required((await ask(`Slug do projeto [${projectDefault}]: `)) || projectDefault, "project");
  const remote = parseGitRemote(gitRemote(projectRoot));
  const owner = required((await ask(`Owner no GitHub [${remote.owner}]: `)) || remote.owner, "owner");
  const repo = required((await ask(`Repo [${remote.repo}]: `)) || remote.repo, "repo");

  out(orcaGuide());

  const orcaRepoId = required(await ask("id do repo no Orca (orca repo list --json): "), "orca-repo-id");
  // Asked, never guessed: the selector fetches HERE before dispatching, and a wrong path means every
  // run is born from a base that silently ages (see core/orca/README.md, "A base tem que ser remota").
  const clonePath = required(
    await ask("Caminho do clone que o Orca usa de base (orca repo list --json → path): "),
    "clone-path",
  );
  const baseBranch = String((await ask("Base branch [main]: ")) ?? "").trim() || "main";
  const agent = String((await ask("Agente do Orca [claude]: ")) ?? "").trim() || "claude";
  const ceilingAnswer = String((await ask("Teto GLOBAL de worktrees simultâneos [4]: ")) ?? "").trim() || "4";
  const globalMaxWorking = Number(ceilingAnswer);
  if (!Number.isInteger(globalMaxWorking) || globalMaxWorking < 1) {
    throw new Error('setup-vps: "globalMaxWorking" precisa ser um inteiro >= 1');
  }
  const titleIncludes = String((await ask("Filtro de título / modo canário (Enter = sem filtro) [[canary]]: ")) ?? "").trim();
  const intervalAnswer = String((await ask("Rodar o selector a cada quantos minutos? [20]: ")) ?? "").trim() || "20";
  const intervalMinutes = Number(intervalAnswer);
  // Asked, never assumed: the cron line carries it, and a wrong path makes every tick fail silently.
  // Validado AQUI, antes de qualquer escrita: `renderCronBlock` também valida, mas só depois do JSON
  // do projeto já estar no disco — e aí um caminho com espaço deixa config órfã sem cron nenhum.
  const orcaBin = assertCronSafe(
    required((await ask(`Binário do Orca para o cron [${DEFAULT_ORCA_BIN}]: `)) || DEFAULT_ORCA_BIN, "orca-bin"),
    "orca-bin",
  );

  const config = buildProjectConfig({
    project, owner, repo, orcaRepoId, clonePath, baseBranch, agent, globalMaxWorking,
    titleIncludes,
    prompt:
      "Rode em MODO AUTÔNOMO (headless). A issue é a spec. Siga a entry-policy do .claude/ deste " +
      "repo: triaging -> orchestrating-delivery headless. Entregue PR (Closes #N) com memória + " +
      "kaizen + testes. NUNCA AskUserQuestion nem plan-mode.",
  });

  const configDir = join(homeDir, ".config", "claude-harness", "projects");
  const configPath = join(configDir, `${project}.json`);
  const logDir = join(homeDir, ".local", "state", "claude-harness");
  const logPath = join(logDir, `${project}.log`);
  ensureDir(configDir);
  ensureDir(logDir);
  writeJson(configPath, config);
  out(`\n✓ Config do projeto em ${configPath}`);

  const cronBlock = renderCronBlock({
    project, orcaBin, nodeBin, selectorPath, configPath, logPath, intervalMinutes,
  });
  writeCrontab(upsertCronBlock(readCrontab(), `${CRON_FENCE_PREFIX}:${project}`, cronBlock));
  out(`✓ Cron do selector registrado (a cada ${intervalMinutes} min, ORCA_BIN=${orcaBin}) — log em ${logPath}`);

  out(reviewAutomationGuide());

  out(
    [
      `✓ Pronto! Projeto "${project}" ligado na entrega autônoma via Orca.`,
      `  • Selector: ${selectorPath}`,
      `  • Paralelizar outro projeto = mais um JSON + mais uma linha (rode este wizard lá).`,
      titleIncludes
        ? `  • Modo canário ATIVO: só issues com "${titleIncludes}" no título entram.`
        : `  • SEM filtro de título: a issue escolhida é a harness:ready aberta mais antiga.`,
      "",
    ].join("\n")
  );

  return { project, configPath, selectorPath, config, cronBlock };
}
