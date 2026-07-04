/**
 * @description Interactive wizard behind `npx claude-harness setup-vps`. Runs ON the VPS: it guides
 * the operator (a non-dev) through configuring the autonomous engine + Telegram notifications —
 * collecting the project/repo coordinates and the Telegram token/chat/thread/heartbeat, EXPLAINING
 * how to obtain each Telegram value, writing the bot token to ~/.claude/.dev.vars (0600, never
 * logged, never committed), and then invoking install-crons to register the crontab + notify config.
 *
 * Every side-effecting seam (ask/out/fs/install-crons) is injectable so the wizard is fully testable
 * with zero real prompts/fs/crontab and the token never touches a log or a test fixture.
 * Node builtins only, zero deps.
 */

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
 * @description Builds the install-crons argv from the collected wizard answers. The Telegram TOKEN
 * is deliberately NOT here — install-crons never receives it (it is read from disk at runtime);
 * only the non-secret chat_id/thread_id/heartbeat coordinates are passed.
 * @param {object} a - Collected answers.
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
 * @param {string} content - Current .dev.vars content ('' if absent).
 * @param {string} token - The bot token to store.
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
 * @description Trims an answer; throws a clear, field-named error when a required value is empty so
 * the wizard fails fast instead of writing a half-config. NEVER echoes a secret value.
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
 * @description Runs the interactive VPS setup wizard. All seams injected for testability.
 * @param {object} deps
 * @param {(question: string) => Promise<string>} deps.ask - TTY line prompt.
 * @param {(text: string) => void} deps.out - stdout writer.
 * @param {Record<string,string|undefined>} deps.env - environment (HOME).
 * @param {(path: string) => string} deps.readFileSafe - safe reader ('' on miss).
 * @param {(path: string, content: string) => void} deps.writeDevVars - writes ~/.claude/.dev.vars 0600.
 * @param {(dir: string) => void} deps.ensureDir - mkdir -p for ~/.claude.
 * @param {(args: string[]) => void} deps.runInstall - invokes install-crons with the built argv.
 * @param {(path: string) => string} deps.devVarsPathFor - resolves the ~/.claude/.dev.vars path for a home dir.
 * @returns {Promise<{ project: string, installArgs: string[] }>}
 */
export async function runSetupVps(deps) {
  const { ask, out, env, readFileSafe, writeDevVars, ensureDir, runInstall, devVarsPathFor } = deps;
  const homeDefault = env.HOME || "";

  out(
    [
      "",
      "=== claude-harness setup-vps — motor autônomo + notificações Telegram na VPS ===",
      "Vou te fazer algumas perguntas e no fim registro os crons e ligo as notificações.",
      "Rode ISTO na sua VPS (é onde o motor vive). Enter aceita o valor entre [colchetes].",
      "",
    ].join("\n")
  );

  const homeDir = required((await ask(`Home dir do operador [${homeDefault}]: `)) || homeDefault, "home-dir");
  const project = required(await ask("Slug do projeto (kebab-case, ex: meu-app): "), "project");
  const owner = required(await ask("Owner no GitHub (ex: orobsonn): "), "owner");
  const repo = required(await ask("Nome do repo (ex: meu-app): "), "repo");
  const projectRoot = required(await ask("Path absoluto do projeto na VPS (project-root): "), "project-root");
  const stateDirDefault = `${projectRoot}/.claude/state`;
  const stateDir = required((await ask(`State dir [${stateDirDefault}]: `)) || stateDirDefault, "state-dir");
  const worktreeRoot = required(await ask("Worktree root (ex: /srv/worktrees): "), "worktree-root");

  out(telegramGuide());

  const token = required(await ask("Cole o TELEGRAM_BOT_TOKEN (do @BotFather): "), "token");
  const chatId = required(await ask("chat_id do grupo (ex: -1003044689525): "), "chat-id");
  const threadId = String((await ask("message_thread_id do tópico (opcional — Enter pra pular): ")) ?? "").trim();
  const hbAnswer = String((await ask("Ativar heartbeat (ping periódico de 'nada a fazer', ~a cada 4h)? [Y/n]: ")) ?? "").trim();
  const heartbeat = !/^n(o|ão|ao)?$/i.test(hbAnswer); // default YES

  // Persist the token to ~/.claude/.dev.vars (0600, never logged). Only a confirmation WITHOUT the
  // value is printed.
  ensureDir(`${homeDir}/.claude`);
  const path = devVarsPathFor(homeDir);
  const nextContent = upsertTokenLine(readFileSafe(path), token);
  writeDevVars(path, nextContent);
  out(`\n✓ Token salvo em ${path} (permissão 0600, fora do git — nunca é exibido nem logado).`);

  const installArgs = buildInstallArgs({
    project, owner, repo, projectRoot, stateDir, worktreeRoot, homeDir,
    chatId: Number(chatId), threadId: threadId || undefined, heartbeat,
  });

  out("\nRegistrando os crons + config de notify...\n");
  runInstall(installArgs);

  out(
    [
      "",
      `✓ Pronto! Projeto "${project}" instalado.`,
      `  • Crons: Cron A (4h) + Cron B (6h) + reaper diário registrados no crontab.`,
      `  • Notificações Telegram: ${heartbeat ? "ON (com heartbeat)" : "ON (sem heartbeat)"}.`,
      `  • Faça um teste: o próximo ciclo do Cron A já deve avisar no grupo.`,
      "",
    ].join("\n")
  );

  return { project, installArgs };
}
