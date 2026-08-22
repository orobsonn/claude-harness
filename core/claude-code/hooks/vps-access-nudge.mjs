/**
 * @description PostToolUse(Bash) hook that fires when a command's output carries one of the failures
 * that READ as "I have no access to the VPS" — and injects the barrier, its fix, and the command that
 * diagnoses it.
 *
 * Why it must be a hook and not documentation: the session that was lost to this never read the
 * playbook. The agent hit `Permission denied (publickey)`, concluded it had no access, and stopped —
 * a doc it never opened cannot reach a conclusion already made. This is the same lesson the
 * `codex-eye-nudge` hook records: a reminder that depends on the model remembering a piece of prose is
 * not a mechanism. The signatures come from `orca-doctor`'s own BARRIERS table, imported rather than
 * copied, so the hook can never drift from the table the docs oracle pins.
 *
 * Fail-open: exits 0 on ANY error, injects nothing when unsure. Never blocks a Bash call.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @description Loads the signature table from the sibling skill. The specifier is a LITERAL — that is
 * what keeps the dependency visible to the vendoring integrity check and to the repo's
 * auditable-import rule — but the import is deferred so it can FAIL. A static import of a file that a
 * partial vendor may not have written kills the process before any try/catch: the header promises
 * "exits 0 on ANY error" and a static import cannot keep that promise. The relative depth is identical
 * in the framework source (core/claude-code/hooks → core/claude-code/skills) and in a vendored project
 * (.claude/hooks → .claude/skills), so one path serves both.
 * @returns {Promise<((text: string) => object|null)|null>}
 */
export async function loadClassifier() {
  try {
    const mod = await import('../skills/connecting-orca/references/orca-doctor.mjs');
    return typeof mod.classifyFailure === 'function' ? mod.classifyFailure : null;
  } catch {
    return null;
  }
}

/**
 * Barriers that name Orca itself, so no command context is needed to know which machine is meant.
 *
 * The ssh-shaped barriers are deliberately NOT here, and that is the whole precision problem: an ssh
 * message says a key/host failed, never WHICH host. `ssh-identity` was in this set and fired on
 * `git push` — `git@github.com: Permission denied (publickey)` — asserting "this is NOT missing access
 * to the VPS" inside the delivery loop, where every run pushes. A hook that exists to stop a confident
 * wrong conclusion must not manufacture one in the other direction.
 */
const UNAMBIGUOUS = new Set(['unknown-environment', 'orca-cli-shim']);

/**
 * Every other barrier only nudges when the command itself was reaching for a remote machine. Keeps
 * `command not found` in an ordinary build, and a publickey denial from a git remote, silent.
 *
 * Two details are load-bearing. An absolute path counts (`/usr/bin/ssh …`, `bash -lc "ssh …"`,
 * backticks) — requiring whitespace before the verb made the incident's own command silent. And the
 * verb must END the path segment (`(?=\s|$|:)`), because `/home/orca/…` is the home directory of the
 * user this playbook creates: matching `orca` inside it fired the nudge on every trivial local ENOENT.
 */
const REMOTE_COMMAND =
  /(?:^|[\s;|&("'`])(?:\S*\/)?(?:ssh|scp|rsync|sftp|orca|tailscale|journalctl|systemctl|crontab)(?=\s|$|:)/i;

/**
 * A tailnet address identifies the VPS wherever it shows up, including in OUTPUT only: `git fetch`
 * against a repo hosted on the VPS names the host in the error, never in the command. Both families
 * count — 100.64.0.0/10 (CGNAT, never a code forge) and Tailscale's `fd7a:115c:a1e0::/48` ULA.
 * The range matters: `100.` alone is 100.0.0.0/8, which includes ordinary AWS addresses, so any build
 * output carrying one plus an unrelated EPERM would have fired the nudge.
 */
const TAILNET_ADDR = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\bfd7a:115c:a1e0:[0-9A-Fa-f:]*/i;

/**
 * A code forge is never the VPS. `ssh -T git@github.com` and `git push` both fail with the same
 * ssh strings, so the host has to veto the nudge even when the command looks remote.
 */
const FORGE_HOST = /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org/i;

/**
 * @description PostToolUse(Bash) may deliver tool_response as a string OR as an object with
 * stdout/stderr. Both forms are flattened to the text the signatures are matched against.
 * @param {object} payload
 * @returns {string}
 */
export function responseText(payload) {
  const raw = payload?.tool_response ?? payload?.tool_output ?? '';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    return [raw.stdout, raw.stderr, raw.output, raw.error]
      .filter((part) => typeof part === 'string')
      .join('\n');
  }
  return '';
}

/**
 * @description Pure decision layer. Returns {action:'inject', barrier, context} or {action:'none'}.
 * Never throws.
 * @param {object} payload - the hook payload
 * @param {(text: string) => object|null} classify - orca-doctor's classifier, injected
 * @returns {{action:string, barrier?:object, context?:string}}
 */
export function decide(payload, classify) {
  try {
    const command = String(payload?.tool_input?.command ?? '');
    const output = responseText(payload);
    if (!output.trim()) return { action: 'none' };

    const barrier = classify(output);
    if (!barrier) return { action: 'none' };
    const remote = REMOTE_COMMAND.test(command) || TAILNET_ADDR.test(command) || TAILNET_ADDR.test(output);
    if (!UNAMBIGUOUS.has(barrier.id) && !remote) return { action: 'none' };
    if (FORGE_HOST.test(command) || FORGE_HOST.test(output)) return { action: 'none' };

    return {
      action: 'inject',
      barrier,
      context: [
        `[vps-access-nudge] Esse comando falhou com "${barrier.symptom}".`,
        `Isso NÃO é falta de acesso à VPS — lê como "${barrier.readsAs}", mas é: ${barrier.cause}.`,
        `Correção: ${barrier.fix}.`,
        'Antes de concluir QUALQUER coisa sobre acesso (e antes de devolver o trabalho ao operador),',
        'rode: node .claude/skills/connecting-orca/references/orca-doctor.mjs --ssh-host <alias> [--environment <nome>]',
        'e reporte a barreira + a correção que ele imprimir.',
      ].join(' '),
    };
  } catch {
    return { action: 'none' };
  }
}

/**
 * @description Full input path: parse, classify, emit. Always returns exit code 0.
 * @param {string} raw - stdin payload
 * @param {(text: string) => object|null} [classify] - injected for tests. OMITTED means "use the
 *   skill's classifier"; passing null explicitly means "there is none", and must stay distinguishable
 *   — otherwise the fail-open path is untestable.
 * @returns {Promise<{exitCode:number, output:string|null}>}
 */
export async function processInput(raw, classify) {
  try {
    const resolve = classify === undefined ? await loadClassifier() : classify;
    if (typeof resolve !== 'function') return { exitCode: 0, output: null };
    const payload = JSON.parse(raw);
    const d = decide(payload, resolve);
    if (d.action !== 'inject') return { exitCode: 0, output: null };
    return {
      exitCode: 0,
      output: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: d.context,
        },
      }),
    };
  } catch {
    return { exitCode: 0, output: null };
  }
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  const result = await processInput(raw);
  if (result.output !== null) process.stdout.write(result.output);
  process.exit(0);
}
