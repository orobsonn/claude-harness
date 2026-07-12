/**
 * @description Interactive wizard behind `npx claude-harness setup-vps` / `node .../cli.mjs setup-vps`.
 * Runs ON the VPS, from inside the project you want to onboard. Designed for the MINIMUM typing:
 * it INFERS everything it can — the engine path (from the script's own location, or an auto-clone),
 * the project (current dir), and owner/repo (the dir's git remote) — so the operator only types what
 * cannot be guessed: the Telegram token + chat_id. Every inferred value is a prompt DEFAULT (Enter
 * accepts, or override).
 *
 * STABLE-ENGINE contract (critical): the crontab install-crons writes points cron at
 * `<engineDir>/core/vps/run-cron-a.mjs`, so the engine MUST live at a durable path. Resolution:
 *   1. `deps.localEngineDir` — this script's own harness clone, when it actually contains core/vps
 *      (the normal case: run from a cloned harness). Stable.
 *   2. else `deps.stableEngineDir` (~/.claude/harness-core) — if core/vps is missing there (e.g. the
 *      wizard is running from the ephemeral npx cache, which does NOT ship core/vps), it is CLONED
 *      once via `deps.cloneEngine`. Never runs the engine from the npx cache.
 *
 * Secret hygiene: the bot token is written to ~/.claude/.dev.vars (0600) and NEVER printed/logged/
 * passed as an install-crons arg. Every side-effecting seam is injectable for hermetic testing.
 * Node builtins only, zero deps.
 */
import { join, basename } from "node:path";

/**
 * @description Self-explanatory guide (pt-br) shown before the Telegram questions: how to get the
 * bot token, add the bot to the group, and read the chat_id + message_thread_id.
 * @returns {string}
 */
export function telegramGuide() {
  return [
    "",
    "──────────────────────────────────────────────────────────────",
    " Configurar o Telegram (uma vez) — como conseguir cada valor:",
    "──────────────────────────────────────────────────────────────",
    "",
    " 1) BOT + TOKEN",
    "    • No Telegram, fale com @BotFather → envie /newbot → siga os passos.",
    "    • Ele devolve um token tipo 123456789:AAH...  ← esse é o TELEGRAM_BOT_TOKEN.",
    "",
    " 2) ADICIONAR O BOT AO GRUPO",
    "    • Abra (ou crie) o grupo — supergroup com Tópicos ativados, se for usar tópico.",
    "    • Adicione o seu bot como membro e dê permissão de postar (admin).",
    "",
    " 3) chat_id DO GRUPO",
    "    • Poste qualquer mensagem no grupo.",
    "    • Abra no navegador: https://api.telegram.org/bot<SEU_TOKEN>/getUpdates",
    '      e procure  "chat":{"id":-100...}  → esse -100... é o chat_id.',
    "    • (Atalho: adicione @RawDataBot ao grupo; ele mostra o chat id na hora.)",
    "",
    " 4) message_thread_id DO TÓPICO (opcional — só se usar Tópicos)",
    "    • No link do tópico (t.me/c/<...>/<N>) o número final costuma ser o thread id.",
    '      Ou procure "message_thread_id" no mesmo getUpdates.',
    "",
    " O token fica SÓ em ~/.claude/.dev.vars (0600, fora do git). Deixe-o à mão.",
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

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
 * @description Builds the install-crons argv from the collected answers. The Telegram TOKEN is
 * deliberately NOT here — install-crons reads it from disk at runtime; only the non-secret
 * chat_id/thread_id/heartbeat coordinates are passed.
 * @param {object} a
 * @returns {string[]}
 */
export function buildInstallArgs(a) {
  const args = [
    "install",
    "--project", a.project,
    "--owner", a.owner,
    "--repo", a.repo,
    "--project-root", a.projectRoot,
    "--state-dir", a.stateDir,
    "--worktree-root", a.worktreeRoot,
    "--home-dir", a.homeDir,
    "--chat-id", String(a.chatId),
  ];
  if (a.threadId !== undefined && a.threadId !== null && String(a.threadId) !== "") {
    args.push("--thread-id", String(a.threadId));
  }
  args.push("--heartbeat", a.heartbeat ? "true" : "false");
  return args;
}

/**
 * @description PURE upsert of the TELEGRAM_BOT_TOKEN line into existing .dev.vars content: replaces
 * an existing `TELEGRAM_BOT_TOKEN=` line (tolerating an `export ` prefix) or appends one, preserving
 * every other line. A missing/empty file yields just the token line.
 * @param {string} content
 * @param {string} token
 * @returns {string}
 */
export function upsertTokenLine(content, token) {
  const line = `TELEGRAM_BOT_TOKEN=${token}`;
  if (!content) return `${line}\n`;
  const lines = content.split("\n");
  let found = false;
  const out = lines.map((l) => {
    if (/^\s*(export\s+)?TELEGRAM_BOT_TOKEN\s*=/.test(l)) {
      found = true;
      return line;
    }
    return l;
  });
  if (found) return out.join("\n");
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}${line}\n`;
}

/**
 * @description Trims an answer; throws a clear, field-named error when a required value is empty.
 * NEVER echoes a secret value.
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
 * @description Resolves the STABLE engine dir (containing core/vps/install-crons.mjs): the script's
 * own clone when valid, else a stable clone dir (cloned once if missing). See module header.
 * @param {object} deps
 * @param {(t: string) => void} out
 * @returns {string} installCronsPath
 */
function resolveInstallCronsPath(deps, out) {
  const rel = ["core", "vps", "install-crons.mjs"];
  let engineDir = deps.localEngineDir || null;
  if (!engineDir || !deps.exists(join(engineDir, ...rel))) {
    engineDir = deps.stableEngineDir;
    if (!deps.exists(join(engineDir, ...rel))) {
      out(`\nMotor do harness (core/vps) não está aqui — clonando uma vez em ${engineDir}...`);
      deps.cloneEngine(engineDir);
    }
  }
  const installCronsPath = join(engineDir, ...rel);
  if (!deps.exists(installCronsPath)) {
    throw new Error(
      `setup-vps: não consegui disponibilizar o motor em ${installCronsPath}. ` +
        `Clone o harness num path estável (git clone https://github.com/orobsonn/claude-harness.git <destino>) ` +
        `e rode de dentro dele: node <destino>/core/claude-code/skills/initializing-projects/references/cli.mjs setup-vps`
    );
  }
  return installCronsPath;
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
 * @param {string} deps.stableEngineDir - fallback stable engine dir (~/.claude/harness-core).
 * @param {(dir: string) => void} deps.cloneEngine - clones the harness (pinned) into dir.
 * @param {(path: string) => boolean} deps.exists
 * @param {(path: string) => string} deps.readFileSafe
 * @param {(path: string, content: string) => void} deps.writeDevVars - 0600 write, never logs the token.
 * @param {(dir: string) => void} deps.ensureDir
 * @param {(path: string) => string} deps.devVarsPathFor
 * @param {(scriptPath: string, args: string[]) => void} deps.runInstall - execs the stable install-crons.
 * @returns {Promise<{ project: string, installArgs: string[], installCronsPath: string }>}
 */
export async function runSetupVps(deps) {
  const { ask, out, env, readFileSafe, writeDevVars, ensureDir, devVarsPathFor, runInstall, cwd, gitRemote } = deps;

  const installCronsPath = resolveInstallCronsPath(deps, out);

  out(
    [
      "",
      "=== claude-harness setup-vps — motor autônomo + notificações Telegram ===",
      "Vou inferir o máximo do projeto atual. Enter aceita o valor entre [colchetes];",
      "você só precisa digitar o token e o chat_id do Telegram.",
      "",
    ].join("\n")
  );

  // Inferred project coordinates — the operator mostly presses Enter.
  const homeDir = required((await ask(`Home dir [${env.HOME ?? ""}]: `)) || env.HOME, "home-dir");
  const projectRoot = required((await ask(`Path do projeto [${cwd}]: `)) || cwd, "project-root");
  const projectDefault = basename(projectRoot);
  const project = required((await ask(`Slug do projeto [${projectDefault}]: `)) || projectDefault, "project");
  const remote = parseGitRemote(gitRemote(projectRoot));
  const owner = required((await ask(`Owner no GitHub [${remote.owner}]: `)) || remote.owner, "owner");
  const repo = required((await ask(`Repo [${remote.repo}]: `)) || remote.repo, "repo");
  const stateDirDefault = join(projectRoot, ".claude", "state");
  const stateDir = required((await ask(`State dir [${stateDirDefault}]: `)) || stateDirDefault, "state-dir");
  const worktreeDefault = join(homeDir, ".claude", "harness-worktrees");
  const worktreeRoot = required((await ask(`Worktree root [${worktreeDefault}]: `)) || worktreeDefault, "worktree-root");

  out(telegramGuide());

  const token = required(await ask("Cole o TELEGRAM_BOT_TOKEN (do @BotFather): "), "token");
  const chatId = required(await ask("chat_id do grupo (ex: -1003044689525): "), "chat-id");
  const threadId = String((await ask("message_thread_id do tópico (opcional — Enter pra pular): ")) ?? "").trim();
  const hbAnswer = String((await ask("Ativar heartbeat (ping periódico de 'nada a fazer', ~a cada 4h)? [Y/n]: ")) ?? "").trim();
  const heartbeat = !/^n(o|ão|ao)?$/i.test(hbAnswer);

  // Persist the token to ~/.claude/.dev.vars (0600, never logged — only a value-free confirmation).
  ensureDir(join(homeDir, ".claude"));
  const devVarsPath = devVarsPathFor(homeDir);
  writeDevVars(devVarsPath, upsertTokenLine(readFileSafe(devVarsPath), token));
  out(`\n✓ Token salvo em ${devVarsPath} (0600, fora do git — nunca exibido nem logado).`);

  const installArgs = buildInstallArgs({
    project, owner, repo, projectRoot, stateDir, worktreeRoot, homeDir,
    chatId: Number(chatId), threadId: threadId || undefined, heartbeat,
  });

  out(`\nRegistrando os crons + notify (via ${installCronsPath})...\n`);
  runInstall(installCronsPath, installArgs);

  out(
    [
      "",
      `✓ Pronto! Projeto "${project}" instalado.`,
      `  • Cron A (4h) + Cron B (6h) + reaper diário no crontab.`,
      `  • Notificações Telegram: ${heartbeat ? "ON (com heartbeat)" : "ON (sem heartbeat)"}.`,
      `  • O próximo ciclo do Cron A já deve avisar no grupo.`,
      "",
    ].join("\n")
  );

  return { project, installArgs, installCronsPath };
}
