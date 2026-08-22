/**
 * @description Diagnoses whether THIS session can operate the Orca runtime on the VPS — and, when it
 * cannot, names the BARRIER and its fix instead of letting the caller conclude "I have no access".
 *
 * Why it exists: a session was lost because an agent hit three failures whose messages all read as
 * "no access" (`Permission denied (publickey)`, `Host key verification failed`,
 * `Operation not permitted`) and stopped, asking the operator to paste commands by hand. Another
 * session on the SAME machine, in the same minute, operated the VPS normally. None of those messages
 * suggests its own fix, and stacked they produce a confident wrong conclusion. This module turns each
 * message into { cause, fix } — the `BARRIERS` table below is the single source those fixes come from,
 * and `core/orca/docs-contract.test.mjs` pins that the playbook's diagnostic table carries the same
 * rows, so code and doc cannot drift apart.
 *
 * Probe rule — ASK A REAL QUESTION, never a version flag. Measured on the live VPS build:
 * `orca --version` exits 3, and the PATH shim registered by Orca Settings can answer `--help` with
 * `bad option: --no-sandbox` (a node arg-parse error from its own ELECTRON_RUN_AS_NODE wrapper) while
 * `/opt/orca/orca-linux.AppImage` answers every command correctly. A liveness probe built on a flag
 * therefore reports "no CLI" on a machine whose CLI works. The probe here is a real command with
 * `--json`, validated against the response envelope.
 *
 * Read-only and fail-soft: it never writes, never repairs, never throws on a failed probe. Node
 * builtins only, every side-effecting seam injected, so the oracle runs hermetically.
 *
 * CLI:
 *   node orca-doctor.mjs [--environment <name>] [--ssh-host <alias>] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The failure classes that READ as "no access" but are not. Ordered: the first match wins, outermost
 * barrier first — a sandbox denial happens before the packet leaves the machine, so it cannot be a
 * key or host-key problem underneath.
 *
 * Every entry carries `docToken`: the substring the playbook's diagnostic row MUST contain for that
 * barrier. It is what the docs oracle asserts, so a fix can never live in code without living in the
 * doc the operator actually reads.
 */
export const BARRIERS = [
  {
    id: "sandbox-network",
    match: /Operation not permitted|EPERM|Network is unreachable/i,
    symptom: "Operation not permitted",
    readsAs: "não tenho permissão pra isso",
    cause: "sandbox do Claude Code — o IP da VPS não está na allowlist de rede",
    fix: "repetir o comando com o sandbox desligado",
    docToken: "sandbox do Claude Code",
  },
  {
    id: "known-hosts",
    match: /Host key verification failed|No .*host key is known|HOST IDENTIFICATION HAS CHANGED/i,
    symptom: "Host key verification failed",
    readsAs: "o alias está quebrado",
    cause: "host ausente do known_hosts — sessão não-interativa falha seca, sem prompt",
    fix: "ssh-keyscan -H <ip-tailscale> >> ~/.ssh/known_hosts",
    docToken: "ssh-keyscan",
  },
  {
    id: "ssh-identity",
    match: /Permission denied \(publickey/i,
    symptom: "Permission denied (publickey)",
    readsAs: "minha chave não está autorizada lá",
    cause: "a chave padrão não é a da VPS — a chave certa nunca chegou a ser oferecida",
    fix: "ssh -i <chave-da-vps>, ou um bloco Host no ~/.ssh/config com IdentityFile + IdentitiesOnly yes",
    docToken: "IdentitiesOnly",
  },
  {
    id: "ssh-host-unresolved",
    match: /Could not resolve hostname|Name or service not known|No route to host/i,
    symptom: "Could not resolve hostname",
    readsAs: "a VPS sumiu",
    cause: "o alias não existe no ~/.ssh/config, ou a tailnet não está de pé nesta máquina",
    fix: "tailscale status para confirmar o IP, e criar o bloco Host no ~/.ssh/config",
    docToken: "tailscale status",
  },
  {
    id: "unknown-environment",
    match: /Unknown environment/i,
    symptom: "Unknown environment: <id>",
    readsAs: "perdi o acesso ao runtime",
    cause: "o runtime do Orca reiniciou e o pareamento não sobreviveu",
    fix: "systemctl restart orca-serve na VPS e parear de novo (orca environment add)",
    docToken: "systemctl restart orca-serve",
  },
  {
    id: "orca-cli-shim",
    match: /bad option: --no-sandbox|orca-ide: bad option/i,
    symptom: "bad option: --no-sandbox",
    readsAs: "o CLI do Orca está quebrado",
    cause: "o shim `orca` do PATH quebra, mas o AppImage responde — são binários diferentes",
    fix: "chamar /opt/orca/orca-linux.AppImage direto (ou exportar ORCA_BIN apontando pra ele)",
    docToken: "/opt/orca/orca-linux.AppImage",
  },
  {
    id: "orca-unknown-command",
    match: /Unknown command/i,
    symptom: "Unknown command: <cmd>",
    readsAs: "esse CLI não faz o que a doc diz",
    cause: "a build instalada não tem esse subcomando (ex.: `repo ls` não existe — é `repo list`)",
    fix: "ler o campo suggestions do próprio erro JSON e usar o nome que ele devolve",
    docToken: "suggestions",
  },
];

/** Orca CLI candidates, in order. `ORCA_BIN` (when set) is prepended by `orcaCandidates`. */
export const DEFAULT_ORCA_CANDIDATES = ["/opt/orca/orca-linux.AppImage", "orca"];

/**
 * @description Classifies a failure's output into a known barrier. Pure. Returns null when the text
 * matches nothing known — an unknown failure is reported verbatim rather than guessed at.
 * @param {string} text combined stderr+stdout of the failed command
 * @returns {(typeof BARRIERS)[number] | null}
 */
export function classifyFailure(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  return BARRIERS.find((b) => b.match.test(t)) ?? null;
}

/**
 * @description Reads the Orca CLI response envelope. EVERY `--json` command answers the same shape —
 * `{ id, ok, result, _meta }` — so the unwrap belongs at the boundary, once (see core/orca/README.md).
 * `ok:false` is a REFUSAL (the CLI ran, understood and said no), which is a different repair from an
 * unreadable answer (the CLI never really answered).
 * @param {string} stdout
 * @returns {{ readable: boolean, ok: boolean, result: any, errorMessage: string }}
 */
export function readEnvelope(stdout) {
  let raw;
  try {
    raw = JSON.parse(String(stdout ?? ""));
  } catch {
    return { readable: false, ok: false, result: null, errorMessage: "" };
  }
  if (!raw || typeof raw !== "object" || !("ok" in raw)) {
    return { readable: false, ok: false, result: null, errorMessage: "" };
  }
  return {
    readable: true,
    ok: raw.ok === true,
    result: raw.result ?? null,
    errorMessage: String(raw?.error?.message ?? ""),
  };
}

/**
 * @description Ordered Orca binary candidates for this machine.
 * @param {Record<string,string|undefined>} env
 * @returns {string[]}
 */
export function orcaCandidates(env = {}) {
  const fromEnv = String(env.ORCA_BIN ?? "").trim();
  return fromEnv ? [fromEnv, ...DEFAULT_ORCA_CANDIDATES.filter((c) => c !== fromEnv)] : [...DEFAULT_ORCA_CANDIDATES];
}

/**
 * @description Does `~/.ssh/config` declare a Host block for this alias? Pure.
 * @param {string} configText
 * @param {string} host
 * @returns {boolean}
 */
export function sshConfigDeclaresHost(configText, host) {
  const alias = String(host ?? "").trim();
  if (!alias) return false;
  return String(configText ?? "")
    .split("\n")
    .some((line) => /^\s*Host\s+/i.test(line) && line.trim().split(/\s+/).slice(1).includes(alias));
}

/**
 * @description Whether `known_hosts` covers this host. Hashed entries (`ssh-keyscan -H`, the form the
 * playbook tells you to write) are opaque by construction, so ABSENCE is never reported as proof —
 * the answer is "unknown". Reporting a hashed known_hosts as "host missing" would invent barrier 2 on
 * a machine that already trusts the host.
 * @param {string} knownHostsText
 * @param {string} host
 * @returns {"yes"|"no"|"unknown"}
 */
export function knownHostsCovers(knownHostsText, host) {
  const text = String(knownHostsText ?? "");
  const needle = String(host ?? "").trim();
  if (!text.trim()) return "no";
  if (needle && text.split("\n").some((l) => l.split(/[\s,]+/).includes(needle))) return "yes";
  return text.split("\n").some((l) => l.startsWith("|1|")) ? "unknown" : "no";
}

/**
 * @description Finds a usable Orca CLI by asking it a real question (`worktree ps --json`) and
 * validating the envelope. A refusal (`ok:false`) still proves the CLI answers — that is a usable
 * binary, reported with its refusal, not a dead one.
 * @param {object} deps
 * @returns {Promise<{status:"ok"|"blocked", bin:string|null, refusal?:string, attempts:Array<object>}>}
 */
export async function probeOrcaBin(deps) {
  const attempts = [];
  for (const bin of orcaCandidates(deps.env)) {
    const r = await deps.run(bin, ["worktree", "ps", "--json"]);
    const env = readEnvelope(r.stdout);
    if (env.readable) {
      attempts.push({ bin, status: "ok", refusal: env.ok ? "" : env.errorMessage });
      return { status: "ok", bin, refusal: env.ok ? "" : env.errorMessage, attempts };
    }
    const barrier = classifyFailure(`${r.stderr ?? ""}\n${r.stdout ?? ""}`);
    attempts.push({ bin, status: "blocked", barrier, detail: firstLine(`${r.stderr ?? ""}\n${r.stdout ?? ""}`) });
  }
  return { status: "blocked", bin: null, attempts };
}

/**
 * @description Probes the paired remote environment: with a name, a real round-trip
 * (`status --environment <name> --json` → reachable/state); without one, the list of environments
 * this machine has paired.
 * @param {object} deps
 * @param {string} bin
 * @returns {Promise<object>}
 */
export async function probeEnvironment(deps, bin) {
  const name = String(deps.environment ?? "").trim();
  if (!name) {
    const r = await deps.run(bin, ["environment", "list", "--json"]);
    const env = readEnvelope(r.stdout);
    const names = Array.isArray(env.result?.environments)
      ? env.result.environments.map((e) => String(e?.name ?? e?.id ?? "")).filter(Boolean)
      : [];
    return { status: names.length ? "listed" : "none", environments: names };
  }
  const r = await deps.run(bin, ["status", "--environment", name, "--json"]);
  const env = readEnvelope(r.stdout);
  if (!env.readable) {
    return {
      status: "blocked",
      environment: name,
      barrier: classifyFailure(`${r.stderr ?? ""}\n${r.stdout ?? ""}`),
      detail: firstLine(`${r.stderr ?? ""}\n${r.stdout ?? ""}`),
    };
  }
  if (!env.ok) {
    return {
      status: "blocked",
      environment: name,
      barrier: classifyFailure(env.errorMessage),
      detail: env.errorMessage,
    };
  }
  const runtime = env.result?.runtime ?? env.result ?? {};
  const reachable = runtime.reachable === true;
  return {
    status: reachable ? "ok" : "unreachable",
    environment: name,
    reachable,
    state: String(runtime.state ?? ""),
  };
}

/**
 * @description Probes SSH with BatchMode on and StrictHostKeyChecking left at its default. Both are
 * deliberate: BatchMode makes a missing key fail as itself instead of hanging on a password prompt,
 * and accepting host keys automatically would MASK barrier 2 — the doctor's job is to surface it with
 * its fix, not to silently trust a host on the operator's behalf.
 * @param {object} deps
 * @returns {Promise<object>}
 */
export async function probeSsh(deps) {
  const host = String(deps.sshHost ?? "").trim();
  if (!host) return { status: "skipped", reason: "nenhum alias SSH informado (--ssh-host)" };
  const r = await deps.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"]);
  const declared = sshConfigDeclaresHost(deps.readFile(join(deps.home, ".ssh", "config")), host);
  const known = knownHostsCovers(deps.readFile(join(deps.home, ".ssh", "known_hosts")), host);
  if (r.code === 0) return { status: "ok", host, declared, known };
  const output = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
  return {
    status: "blocked",
    host,
    declared,
    known,
    barrier: classifyFailure(output),
    detail: firstLine(output),
  };
}

/** @description First non-empty line of a command's output, trimmed. @param {string} text @returns {string} */
export function firstLine(text) {
  return String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * What each open path can actually do. The split is not obvious and costs a session when guessed:
 * the CLI's `--environment` reaches everything that is Orca's own state, and NOTHING that is the
 * machine's (a config file, a crontab, a systemd unit).
 */
export const CAPABILITIES = {
  viaEnvironment: [
    "orca repo list --environment <env> --json",
    "orca worktree list|ps --environment <env> --json",
    "orca automations list --environment <env> --json",
    "orca worktree create ... --environment <env>",
  ],
  requiresSsh: [
    "escrever ~/.config/claude-harness/projects/<slug>.json",
    "crontab do usuário orca (a linha do selector)",
    "systemctl status|restart orca-serve · journalctl -u orca-serve",
    "atualizar o AppImage / instalar pacote do sistema",
  ],
};

/**
 * @description Runs every probe and returns the structured report. NEVER concludes "no access": when
 * a path is blocked it carries the barrier that blocked it and that barrier's fix.
 * @param {object} deps
 * @param {(cmd:string, args:string[]) => Promise<{code:number,stdout:string,stderr:string}>} deps.run
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {string} deps.home
 * @param {(path:string) => string} deps.readFile - '' when unreadable, never throws.
 * @param {string} [deps.environment] - paired Orca environment name to round-trip.
 * @param {string} [deps.sshHost] - ssh alias/host to probe.
 * @returns {Promise<object>}
 */
export async function diagnose(deps) {
  const orca = await probeOrcaBin(deps);
  const environment = orca.status === "ok" ? await probeEnvironment(deps, orca.bin) : { status: "skipped", reason: "sem CLI do Orca utilizável" };
  const ssh = await probeSsh(deps);

  const barriers = [];
  const collect = (b) => {
    if (b && !barriers.some((x) => x.id === b.id)) barriers.push(b);
  };
  for (const a of orca.attempts) collect(a.barrier);
  collect(environment.barrier);
  collect(ssh.barrier);

  const orcaOpen = orca.status === "ok";
  const sshOpen = ssh.status === "ok";
  return {
    ok: orcaOpen || sshOpen,
    orca,
    environment,
    ssh,
    barriers,
    capabilities: CAPABILITIES,
    verdict: buildVerdict({ orcaOpen, sshOpen, environment, barriers }),
  };
}

/**
 * @description The one line the caller is most likely to act on. It never says "sem acesso": with
 * every path blocked it says the barriers are NOT missing access and points at the fixes.
 * @param {{orcaOpen:boolean, sshOpen:boolean, environment:object, barriers:Array<object>}} args
 * @returns {string}
 */
export function buildVerdict({ orcaOpen, sshOpen, environment, barriers }) {
  const names = barriers.map((b) => b.id).join(", ");
  if (orcaOpen && sshOpen) return "VPS operável pelos dois caminhos: CLI do Orca e SSH.";
  if (orcaOpen && !sshOpen) {
    const suffix = barriers.length ? ` SSH bloqueado por: ${names} — cada uma com correção abaixo.` : "";
    return `Operável pelo CLI do Orca (tudo que é do Orca vai por --environment).${suffix}`;
  }
  if (!orcaOpen && sshOpen) {
    return "Operável por SSH. O CLI local do Orca não respondeu — o que é do Orca pode ser feito por SSH na VPS.";
  }
  return barriers.length
    ? `Nenhum caminho aberto AINDA — e isto NÃO é falta de acesso: ${names}. Cada barreira tem correção abaixo; aplique e rode de novo.`
    : "Nenhum caminho aberto e nenhuma barreira conhecida reconhecida — reporte a saída bruta ao operador, sem concluir que falta acesso.";
}

/**
 * @description Renders the operator-facing report (pt-br). Machine-facing detail stays in `--json`.
 * @param {object} report
 * @returns {string}
 */
export function renderReport(report) {
  const L = [];
  L.push("");
  L.push("=== orca-doctor — esta sessão consegue operar a VPS? ===");
  L.push("");
  L.push(`VEREDITO: ${report.verdict}`);
  L.push("");
  L.push(`CLI do Orca : ${report.orca.status === "ok" ? `ok (${report.orca.bin})` : "bloqueado"}`);
  for (const a of report.orca.attempts) {
    if (a.status === "blocked") L.push(`  · ${a.bin} → ${a.barrier ? a.barrier.id : "falha não classificada"}: ${a.detail}`);
  }
  if (report.environment.status === "ok") {
    L.push(`Ambiente    : ok — ${report.environment.environment} (state=${report.environment.state}, reachable=true)`);
  } else if (report.environment.status === "listed") {
    L.push(`Ambiente    : pareados nesta máquina — ${report.environment.environments.join(", ")}`);
  } else if (report.environment.status === "none") {
    L.push("Ambiente    : nenhum pareado nesta máquina — `orca environment add --name <nome> --pairing-code <code>`");
  } else if (report.environment.status !== "skipped") {
    L.push(`Ambiente    : ${report.environment.status} — ${report.environment.detail ?? ""}`);
  }
  L.push(
    `SSH         : ${report.ssh.status === "ok" ? `ok (${report.ssh.host})` : report.ssh.status === "skipped" ? `pulado — ${report.ssh.reason}` : `bloqueado — ${report.ssh.detail}`}`,
  );
  if (report.ssh.status !== "skipped" && report.ssh.declared === false) {
    L.push(`  · sem bloco Host para "${report.ssh.host}" no ~/.ssh/config — é ele que fixa a chave certa`);
  }

  if (report.barriers.length) {
    L.push("");
    L.push("BARREIRAS (nenhuma delas é falta de acesso):");
    for (const b of report.barriers) {
      L.push(`  ▸ ${b.symptom}`);
      L.push(`      lê como : "${b.readsAs}"`);
      L.push(`      é       : ${b.cause}`);
      L.push(`      corrige : ${b.fix}`);
    }
  }

  L.push("");
  L.push("DIVISÃO DE TRABALHO (o atalho que dispensa SSH):");
  for (const c of report.capabilities.viaEnvironment) L.push(`  --environment : ${c}`);
  for (const c of report.capabilities.requiresSsh) L.push(`  precisa SSH   : ${c}`);
  L.push("");
  return L.join("\n");
}

/**
 * @description Real seams. `run` never throws and never inherits stdio: a failed probe is DATA here,
 * not an exception, because every interesting case in this module is a failure.
 * @returns {object}
 */
export function realDeps(argv = {}) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return {
    env: process.env,
    home,
    environment: argv.environment ?? process.env.ORCA_ENVIRONMENT ?? "",
    sshHost: argv.sshHost ?? process.env.HARNESS_VPS_SSH_HOST ?? "",
    readFile: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      } catch {
        return "";
      }
    },
    run: async (cmd, args) => {
      try {
        const stdout = execFileSync(cmd, args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
        return { code: 0, stdout, stderr: "" };
      } catch (err) {
        return {
          code: typeof err?.status === "number" ? err.status : 1,
          stdout: String(err?.stdout ?? ""),
          stderr: String(err?.stderr ?? err?.message ?? ""),
        };
      }
    },
  };
}

/**
 * @description Parses the CLI flags. Pure.
 * @param {string[]} argv
 * @returns {{environment:string, sshHost:string, json:boolean}}
 */
export function parseDoctorArgs(argv) {
  const out = { environment: "", sshHost: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--environment" && argv[i + 1]) out.environment = String(argv[++i]);
    else if (argv[i] === "--ssh-host" && argv[i + 1]) out.sshHost = String(argv[++i]);
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

/**
 * @description Entry used by both the direct-CLI block below and `claude-harness orca-doctor`.
 * Always exits 0: a blocked path is a diagnosis to read, not a command that failed.
 * @param {string[]} argv
 * @param {(text:string) => void} out
 * @returns {Promise<object>}
 */
export async function runOrcaDoctor(argv, out) {
  const flags = parseDoctorArgs(argv);
  const report = await diagnose(realDeps(flags));
  out(flags.json ? JSON.stringify(report, null, 2) : renderReport(report));
  return report;
}

// Symlink-safe direct-CLI entry: argv may be core/skills/... while import.meta.url is core/claude-code/skills/...
if (
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return process.argv[1] === fileURLToPath(import.meta.url);
    }
  })()
) {
  await runOrcaDoctor(process.argv.slice(2), (t) => process.stdout.write(`${t}\n`));
}
