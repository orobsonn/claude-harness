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
 * A CONFIDENT WRONG ANSWER HERE IS WORSE THAN NO ANSWER. The first version of this module reported
 * "operável pelo CLI do Orca (tudo que é do Orca vai por --environment)" on a machine with ZERO paired
 * environments and no SSH probe — the incident's defect inverted, produced by the tool built to prevent
 * it. Hence `diagnose` separates three independent facts and never merges them:
 *   1. does the CLI answer at all?  2. is there a runtime THIS machine already drives (it may BE the
 *   host)?  3. is a REMOTE environment reachable (the only fact that proves a client can reach a VPS)?
 * A verdict may only claim what a probe actually returned, and each blocked path carries its own
 * barriers — an environment failure is never reported as an SSH failure.
 *
 * Probe rule — ASK A REAL QUESTION, never a version flag. Measured on the live VPS build: the `orca`
 * shim registered on PATH can answer any command with `bad option: --no-sandbox` (a node arg-parse
 * error from its own ELECTRON_RUN_AS_NODE wrapper) while `/opt/orca/orca-linux.AppImage` answers
 * correctly, and `--version` exits non-zero whenever another instance already holds the profile lock —
 * i.e. always, on a machine running `orca-serve`. A liveness check built on a flag reports "no CLI" on
 * a machine whose CLI works. The probe here is a real command with `--json`, validated as an envelope.
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
 * The failure classes that READ as "no access" but are not. Ordered: the first match wins.
 *
 * Two ordering rules, both learned by getting them wrong:
 *   - The sandbox pattern is ANCHORED to a connection attempt. An unanchored `Operation not permitted`
 *     hijacks any multi-line stderr that merely contains those words (an unreadable identity file, for
 *     one) and then prescribes DISABLING THE SANDBOX — a security downgrade recommended for a cause
 *     that has nothing to do with the sandbox.
 *   - Unreachable-network siblings (`Network is unreachable`, `No route to host`) live with
 *     `Could not resolve hostname`, not with the sandbox: same root cause (the tailnet is not up /
 *     the host is not there), same fix. Splitting them sent two halves of one failure to contradictory
 *     repairs.
 *
 * Every entry carries `docToken`: the substring the playbook's diagnostic row MUST contain for that
 * barrier. It is what the docs oracle asserts, so a fix can never live in code without living in the
 * doc the operator actually reads.
 */
/**
 * The syscall vocabulary of a DENIED connection, declared as data so the oracle can prove every verb
 * has a real fixture. It is not a guess: `ping` fails at `sendmsg`/`socket`, a resolver at
 * `getaddrinfo`, ssh mid-handshake at `read`. Anchoring on `connect` alone made those vanish
 * entirely — a barrier that disappears is worse than one that over-matches, because the operator is
 * left with no fix at all. (`connect` also covers `connecting`, `connect()` and `connect to`.)
 */
export const SANDBOX_VERBS = [
  "connect",
  "connecting", // wget: `Connecting to 100.98.45.37:443... failed: Operation not permitted.`
  "bind",
  "sendto",
  "sendmsg",
  "socket",
  "getaddrinfo",
  "ssh_exchange_identification", // the ssh handshake form, which is where a `read:` legitimately means the socket
];

/**
 * A verb only counts when it appears as a SYSCALL TOKEN — immediately followed by `:`, `(`, ` to`, or
 * ` EPERM`. Joining the verbs raw was worse than the unanchored pattern it replaced: `read` is a
 * substring of `already` and `pthread`, `write` of `write-cache`, `socket` of `docker.socket`, so an
 * ordinary filesystem `Operation not permitted` was answered with "disable the sandbox" — advice that
 * cannot help, for a cause that is not the sandbox. Word boundaries alone do not fix it (a path like
 * `./read-only-dir` still has them); the qualifier does, because a denied syscall always names itself.
 *
 * `read` and `write` are NOT in the list, and that is the point: as tokens they are overwhelmingly
 * file operations — `strace` prints `read(3, …) = -1 EPERM` for a file descriptor, and `strace` is
 * exactly what someone runs while investigating a permission error. The one form where a `read:`
 * really is the socket is the ssh handshake, so that form is named directly instead.
 */
const VERB_ALTERNATION = SANDBOX_VERBS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * `read`/`write` stay OUT of the verb list (they are file operations far more often than socket ones),
 * but the forms where they unambiguously name a socket are matched directly: Go's `net.OpError`
 * (`write tcp 10.0.0.2:5000->100.98.45.37:22: write: operation not permitted`) and Node's
 * `Error: write EPERM` — and this harness is Node end to end. `read(3, …)` from strace and
 * `Cannot read:` from tar match neither.
 */
const SOCKET_READ_WRITE = "\\b(?:read|write)\\s+(?:tcp|udp)\\b[^\\n]*(?:Operation not permitted|EPERM)|\\b(?:read|write)\\s+EPERM\\b";

/**
 * A library call on a socket, with the method list CLOSED to operations a network sandbox can actually
 * deny. Accepting any method (`socket\.\w+`) answered `socket.timeout:`, `socket.gaierror:` and
 * `socket.close:` — a timeout, a DNS failure and a close — with "disable the sandbox". A systemd unit
 * path (`foo.socket:`) has no method after the dot and never matched either way.
 */
const SOCKET_METHOD =
  "\\bsocket\\.(?:connect|connect_ex|send|sendall|sendto|sendmsg|bind|create_connection|error)\\s*:[^\\n]*(?:Operation not permitted|EPERM)";

const SANDBOX_MATCH = new RegExp(
  `(?:\\b(?:${VERB_ALTERNATION})\\b\\s*(?::|\\(|\\s+to\\b)[^\\n]*(?:Operation not permitted|EPERM)` +
    `|\\b(?:${VERB_ALTERNATION})\\b\\s+EPERM\\b` +
    `|${SOCKET_READ_WRITE}` +
    `|${SOCKET_METHOD})`,
  "i",
);

export const BARRIERS = [
  {
    id: "sandbox-network",
    match: SANDBOX_MATCH,
    // D-Bus speaks the same words and has nothing to do with the network sandbox. Anchored on the
    // colon, or a host merely NAMED `bus.example.com` loses its barrier entirely.
    // A D-Bus address may follow the word `bus` separated by a space (`to bus tcp:host=…`), not only
    // by a colon.
    veto: /\bto (?:the )?bus\s*(?::|(?=\s+(?:tcp|unix|autolaunch):))|(?:^|[^A-Za-z])s?d[-_]?bus|system_bus_socket/i,
    // …unless the line carries a network co-signal. The veto pattern has no anchor, so a HOST named
    // `sdbus.internal` or `dbus-vps.tail.ts.net` was losing its barrier entirely — the veto reopening,
    // one letter to the side, the very class the anchor closed. Real D-Bus messages carry no port,
    // no IP and no `tcp`.
    // The co-signal must be a co-signal of a REMOTE CONNECTION, not of the word `tcp`: D-Bus over TCP
    // (`tcp:host=100.98.45.37,port=5555`) carries both a `tcp` and an IP and is still D-Bus. A real
    // connection error writes `port 22` with a space; a D-Bus address writes `port=5555`.
    vetoUnless: /\bport \d+|(?<!host=)\b\d{1,3}(?:\.\d{1,3}){3}\b/i,
    symptom: "Operation not permitted",
    readsAs: "não tenho permissão pra isso",
    cause: "sandbox do Claude Code — o IP da VPS não está na allowlist de rede",
    fix: "reexecutar o MESMO comando com o sandbox do Bash desligado",
    docToken: "sandbox do Bash desligado",
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
    match: /Could not resolve hostname|Name or service not known|No route to host|Network is unreachable/i,
    symptom: "Could not resolve hostname",
    readsAs: "a VPS sumiu",
    cause: "o alias não existe no ~/.ssh/config, ou a tailnet não está de pé nesta máquina (mesma família: No route to host, Network is unreachable)",
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
  {
    // Last on purpose: ENOENT is how a MISSING binary surfaces, and putting it earlier would let an
    // unrelated "no such file" line in a longer stderr outrank a real ssh diagnosis.
    id: "orca-cli-missing",
    match: /ENOENT|command not found/i,
    symptom: "ENOENT",
    readsAs: "esta máquina não fala com o Orca",
    cause: "o CLI do Orca não está instalado aqui (o caso normal num laptop), ou ORCA_BIN aponta pro lugar errado",
    fix: "instalar o Orca desktop (https://onorca.dev) ou exportar ORCA_BIN apontando pro binário",
    docToken: "ORCA_BIN",
  },
];

/** Orca CLI candidates, in order. `ORCA_BIN` (when set) is prepended by `orcaCandidates`. */
export const DEFAULT_ORCA_CANDIDATES = ["/opt/orca/orca-linux.AppImage", "orca"];

/**
 * Per-probe ceiling. Deliberately small: this module runs when a session is already stuck, and the
 * previous 120s budget meant a silent doctor for up to ten minutes across candidates — long enough
 * that an agent gives up on the tool that exists to stop it giving up. A real answer takes ~1s.
 * (It also bounds the `orca` PATH candidate colliding with GNOME's `orca` screen reader on a desktop:
 * whatever that launches, it never answers the envelope, and it is killed in seconds.)
 */
export const PROBE_TIMEOUT_MS = 15_000;

/** A plain hostname or alias. Must start alphanumeric, which is what keeps `-oProxyCommand=…` out. */
const SAFE_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An IPv6 literal, optionally bracketed and with a zone id. Tailscale assigns EVERY node an address
 * in `fd7a:115c:a1e0::/48`, so refusing IPv6 refuses the tailnet — the first guard did exactly that
 * and silently dropped the only path the operator had asked for, which is worse than the injection it
 * was written to stop: it does not run the wrong thing, it runs nothing and says nothing useful.
 */
const SAFE_IPV6 = /^\[?[0-9A-Fa-f:]*:[0-9A-Fa-f:]*\]?(?:%[A-Za-z0-9._-]+)?$/;

/**
 * @description Whether a host/alias is safe to pass to `ssh` in argument position. A value starting
 * with `-` is parsed by ssh as an OPTION, so `--ssh-host "-oProxyCommand=…"` would execute an
 * arbitrary command — the diagnosis tool becoming an execution primitive. Accepts what ssh accepts as
 * a destination (`host`, `user@host`, an IPv6 literal); anything else is refused, never sanitized.
 * @param {string} host
 * @returns {boolean}
 */
export function isSafeHost(host) {
  const value = String(host ?? "").trim();
  if (!value || value.length > 255) return false;
  const match = value.match(/^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?(.+)$/);
  if (!match) return false;
  const target = match[2];
  return SAFE_HOSTNAME.test(target) || SAFE_IPV6.test(target);
}

/**
 * @description Whether an Orca environment NAME is usable. Deliberately NOT `isSafeHost`: a name is a
 * human field (`orca environment add --name "vps são paulo"`) that travels in argv after
 * `--environment`, never through a shell — applying a hostname regex to it rejected legitimate names
 * and degraded the verdict for no security gain. Only a leading `-` (an option to the CLI) and
 * newlines are refused. Pure.
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeEnvironmentName(name) {
  const value = String(name ?? "").trim();
  return value.length > 0 && value.length <= 255 && !value.startsWith("-") && !/[\n\r]/.test(value);
}

/**
 * @description Classifies a failure's output into a known barrier. Pure. Returns null when the text
 * matches nothing known — an unknown failure is reported verbatim rather than guessed at.
 * @param {string} text combined stderr+stdout of the failed command
 * @returns {(typeof BARRIERS)[number] | null}
 */
export function classifyFailure(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const vetoed = (b) => Boolean(b.veto?.test(t)) && !b.vetoUnless?.test(t);
  return BARRIERS.find((b) => b.match.test(t) && !vetoed(b)) ?? null;
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
  const text = String(stdout ?? "");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // A wrapper may print a banner before the JSON; the envelope still starts at the first `{`.
    const start = text.indexOf("{");
    if (start === -1) return { readable: false, ok: false, result: null, errorMessage: "" };
    try {
      raw = JSON.parse(text.slice(start));
    } catch {
      return { readable: false, ok: false, result: null, errorMessage: "" };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("ok" in raw)) {
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
  // `Host harness-*` is the ordinary way to write a tailnet config; exact-token matching reported
  // "no Host block" for a config that declares the host perfectly well.
  if (hasMatchBlock(configText)) return true;
  return String(configText ?? "")
    .split("\n")
    .some((line) => {
      if (!/^\s*Host\s+/i.test(line)) return false;
      const patterns = patternsOf(line);
      // ssh semantics: a matching NEGATED pattern excludes the host from the block entirely.
      if (patterns.some((p) => p.startsWith("!") && globMatches(p.slice(1), alias))) return false;
      return patterns.some((p) => globMatches(p, alias));
    });
}

/** @description Tokens after the `Host`/`Match` keyword. @param {string} line @returns {string[]} */
function patternsOf(line) {
  return line.trim().split(/\s+/).slice(1);
}

/**
 * @description ssh_config glob: `*` any run, `?` one char. Negated patterns (`!host`) are treated as
 * non-matching rather than parsed. Pure.
 * @param {string} pattern @param {string} value @returns {boolean}
 */
function globMatches(pattern, value) {
  if (!pattern || pattern.startsWith("!")) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * @description Does the config use `Match` blocks? Their conditions (`exec`, `originalhost`, …) are
 * not statically resolvable here, so their presence makes any "this host is not declared" claim
 * unsound — the doctor stays silent instead of asserting something it cannot know.
 * @param {string} configText @returns {boolean}
 */
function hasMatchBlock(configText) {
  return String(configText ?? "").split("\n").some((line) => /^\s*Match\s+\S/i.test(line));
}

/**
 * @description The `HostName` an alias resolves to, or "" when the alias is not declared. Needed
 * because `known_hosts` stores the real hostname/IP and NEVER the alias — comparing an alias against
 * it would report "host missing" on a machine that already trusts the host. Pure.
 * @param {string} configText
 * @param {string} host
 * @returns {string}
 */
export function sshConfigHostName(configText, host) {
  const alias = String(host ?? "").trim();
  if (!alias) return "";
  let inside = false;
  for (const line of String(configText ?? "").split("\n")) {
    if (/^\s*(?:Host|Match)\s+/i.test(line)) {
      inside = /^\s*Host\s+/i.test(line) && patternsOf(line).some((p) => globMatches(p, alias));
      continue;
    }
    if (inside) {
      const m = line.match(/^\s*HostName\s+(\S+)/i);
      // `%h` and friends are ssh tokens expanded at connect time; returning one literally would be a
      // hostname that exists nowhere.
      if (m) return m[1].includes("%") ? "" : m[1];
    }
  }
  return "";
}

/**
 * @description Whether `known_hosts` covers this host. Hashed entries (`ssh-keyscan -H`, the form the
 * playbook tells you to write) are opaque by construction, so ABSENCE is never reported as proof —
 * the answer is "unknown". Both the alias and its resolved `HostName` are checked, since only the
 * latter is what ssh actually stores.
 * @param {string} knownHostsText
 * @param {string[]} names
 * @returns {"yes"|"no"|"unknown"}
 */
export function knownHostsCovers(knownHostsText, names) {
  const text = String(knownHostsText ?? "");
  const needles = (Array.isArray(names) ? names : [names]).map((n) => String(n ?? "").trim()).filter(Boolean);
  if (!text.trim()) return "no";
  const lines = text.split("\n");
  if (needles.some((needle) => lines.some((l) => l.split(/[\s,]+/).includes(needle)))) return "yes";
  return lines.some((l) => l.startsWith("|1|")) ? "unknown" : "no";
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
 * @description Does THIS machine already drive a runtime (i.e. is it the Orca host itself)? On the VPS
 * the local CLI IS the runtime and no environment is ever paired — without this probe, "zero
 * environments" would be reported as "no path to the runtime" on the very machine that runs it.
 * @param {object} deps
 * @param {string} bin
 * @returns {Promise<{status:"ok"|"absent"|"unreadable", state?:string}>}
 */
export async function probeLocalRuntime(deps, bin) {
  const r = await deps.run(bin, ["status", "--json"]);
  const env = readEnvelope(r.stdout);
  if (!env.readable || !env.ok) return { status: "unreadable" };
  const runtime = env.result?.runtime ?? {};
  return runtime.reachable === true
    ? { status: "ok", state: String(runtime.state ?? "") }
    : { status: "absent", state: String(runtime.state ?? "") };
}

/**
 * @description Probes the paired REMOTE environment: with a name, a real round-trip
 * (`status --environment <name> --json` → reachable/state); without one, the list of environments
 * this machine has paired. This is the only fact that proves a CLIENT machine reaches a VPS.
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
  if (!isSafeEnvironmentName(name)) {
    return { status: "skipped", environment: name, reason: "nome de ambiente inválido (não foi usado)" };
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
  if (!isSafeHost(host)) {
    // Never sanitized, never passed through: `ssh` reads a leading `-` as an option, so an alias like
    // `-oProxyCommand=…` would make this read-only diagnosis execute a command.
    return { status: "skipped", host, reason: "alias SSH inválido — recusado sem executar nada" };
  }
  const config = deps.readFile(join(deps.home, ".ssh", "config"));
  const declared = sshConfigDeclaresHost(config, host);
  const hostName = sshConfigHostName(config, host);
  const known = knownHostsCovers(deps.readFile(join(deps.home, ".ssh", "known_hosts")), [hostName, host]);
  const r = await deps.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"]);
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
 * a path is blocked it carries the barrier that blocked it and that barrier's fix. It also never
 * claims a path a probe did not actually prove — `ok` means "some route to the runtime answered",
 * not "the CLI is installed".
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
  const cliOk = orca.status === "ok";
  const localRuntime = cliOk ? await probeLocalRuntime(deps, orca.bin) : { status: "skipped" };
  const environment = cliOk ? await probeEnvironment(deps, orca.bin) : { status: "skipped", reason: "sem CLI do Orca utilizável" };
  const ssh = await probeSsh(deps);

  const dedupe = (list) => {
    const out = [];
    for (const b of list) if (b && !out.some((x) => x.id === b.id)) out.push(b);
    return out;
  };
  // Barriers stay attributed to the path they blocked. Reporting an environment failure under "SSH
  // blocked by …" sends the operator to repair the wrong thing.
  const orcaBarriers = dedupe([...orca.attempts.map((a) => a.barrier), environment.barrier]);
  const sshBarriers = dedupe([ssh.barrier]);

  const remoteOpen = environment.status === "ok";
  const localOpen = localRuntime.status === "ok";
  const sshOpen = ssh.status === "ok";

  return {
    // `ok` means "some runtime answered", which on the Orca host itself is the local one. A machine
    // reader that needs "can I reach the VPS from here" must read `paths`, not `ok`.
    ok: remoteOpen || localOpen || sshOpen,
    paths: { remote: remoteOpen, local: localOpen, ssh: sshOpen },
    orca,
    localRuntime,
    environment,
    ssh,
    barriers: dedupe([...orcaBarriers, ...sshBarriers]),
    orcaBarriers,
    sshBarriers,
    capabilities: CAPABILITIES,
    verdict: buildVerdict({ cliOk, localOpen, remoteOpen, sshOpen, environment, orcaBarriers, sshBarriers }),
  };
}

/**
 * @description The one line the caller is most likely to act on — so it may only state what a probe
 * returned. It never says "sem acesso": with every path blocked it says the barriers are NOT missing
 * access and points at the fixes.
 * @param {object} args
 * @returns {string}
 */
export function buildVerdict({ cliOk, localOpen, remoteOpen, sshOpen, environment, orcaBarriers = [], sshBarriers = [] }) {
  const ids = (list) => list.map((b) => b.id).join(", ");
  const sshNote = sshOpen
    ? " SSH aberto."
    : sshBarriers.length
      ? ` SSH bloqueado por: ${ids(sshBarriers)} — correção abaixo.`
      : "";

  if (remoteOpen) {
    return `Operável: o ambiente "${environment.environment}" respondeu (reachable). Tudo que é do Orca vai por --environment.${sshNote}`;
  }
  if (localOpen) {
    const paired = environment.status === "listed" ? ` Ambientes pareados aqui: ${environment.environments.join(", ")} — rode com --environment <nome> para provar o round-trip.` : "";
    return `Este CLI opera o runtime desta MÁQUINA (nenhum ambiente remoto provado). Se a VPS é outra máquina, pareie (orca environment add) ou use SSH.${paired}${sshNote}`;
  }
  if (sshOpen) {
    return "Operável por SSH. Nenhum runtime do Orca respondeu localmente — o que é do Orca pode ser feito por SSH na VPS.";
  }
  const all = ids([...orcaBarriers, ...sshBarriers]);
  if (all) {
    return `Nenhum caminho aberto AINDA — e isto NÃO é falta de acesso: ${all}. Cada barreira tem correção abaixo; aplique e rode de novo.`;
  }
  return cliOk
    ? "O CLI respondeu, mas nenhum runtime foi alcançado e nenhuma barreira conhecida apareceu — reporte a saída bruta ao operador, sem concluir que falta acesso."
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
  L.push(`CLI do Orca  : ${report.orca.status === "ok" ? `ok (${report.orca.bin})` : "bloqueado"}`);
  for (const a of report.orca.attempts) {
    if (a.status === "blocked") L.push(`  · ${a.bin} → ${a.barrier ? a.barrier.id : "falha não classificada"}: ${a.detail}`);
  }
  L.push(
    `Runtime local: ${report.localRuntime.status === "ok" ? `ok (state=${report.localRuntime.state}) — esta máquina É um host Orca` : report.localRuntime.status === "absent" ? "nenhum runtime rodando aqui" : "não verificado"}`,
  );
  if (report.environment.status === "ok") {
    L.push(`Ambiente     : ok — ${report.environment.environment} (state=${report.environment.state}, reachable=true)`);
  } else if (report.environment.status === "listed") {
    L.push(`Ambiente     : pareados aqui — ${report.environment.environments.join(", ")} (round-trip NÃO provado: rode com --environment <nome>)`);
  } else if (report.environment.status === "none") {
    L.push("Ambiente     : nenhum pareado nesta máquina — `orca environment add --name <nome> --pairing-code <code>`");
  } else if (report.environment.status === "unreachable") {
    L.push(`Ambiente     : ${report.environment.environment} pareado, mas NÃO alcançável (state=${report.environment.state})`);
  } else if (report.environment.status === "blocked") {
    L.push(`Ambiente     : bloqueado — ${report.environment.detail ?? ""}`);
  }
  L.push(
    `SSH          : ${report.ssh.status === "ok" ? `ok (${report.ssh.host})` : report.ssh.status === "skipped" ? `pulado — ${report.ssh.reason}` : `bloqueado — ${report.ssh.detail}`}`,
  );
  if (report.ssh.status === "blocked" && report.ssh.declared === false) {
    L.push(`  · sem bloco Host para "${report.ssh.host}" no ~/.ssh/config — é ele que fixa a chave certa`);
  }
  if (report.ssh.status === "blocked" && report.ssh.barrier?.id === "known-hosts" && report.ssh.known === "no") {
    L.push("  · o host não aparece no ~/.ssh/known_hosts (nenhuma entrada hasheada para desempatar)");
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
 * not an exception, because every interesting case in this module is a failure. `LC_ALL=C` is forced
 * because the barrier table matches C-locale strings — under pt_BR, `ssh` prints `strerror(errno)`
 * translated ("Operação não permitida") and every classification silently returns null.
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
      const options = {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PROBE_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      };
      try {
        return { code: 0, stdout: execFileSync(cmd, args, options), stderr: "" };
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
