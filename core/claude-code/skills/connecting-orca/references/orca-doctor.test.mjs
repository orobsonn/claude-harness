/**
 * @description Frozen oracle for orca-doctor. Every seam injected — ZERO real CLI, ssh, or fs.
 *
 * What it pins is the defect the module exists for: three failures whose messages read as "no access"
 * (`Permission denied (publickey)`, `Host key verification failed`, `Operation not permitted`) made an
 * agent stop and hand the work back to the operator, while another session on the same machine, in the
 * same minute, operated the VPS fine.
 *
 * And what it pins SECOND is the defect this oracle itself missed the first time: the module answered
 * "operável pelo CLI do Orca" on a machine with zero paired environments and no SSH probe. A tool that
 * produces a confident wrong conclusion is the incident, not the cure — so the verdict tests below
 * assert that every claim traces to a probe that actually returned, and the barrier fixtures are real
 * captured stderr covering EVERY alternative of every pattern (a hand-written string chosen to match
 * the regex proves only that the author can read their own regex — the `parseWorktreePs` defect
 * recorded in core/orca/README.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BARRIERS,
  CAPABILITIES,
  SANDBOX_VERBS,
  isSafeEnvironmentName,
  buildVerdict,
  classifyFailure,
  diagnose,
  isSafeHost,
  knownHostsCovers,
  orcaCandidates,
  parseDoctorArgs,
  probeEnvironment,
  probeOrcaBin,
  probeSsh,
  readEnvelope,
  renderReport,
  sshConfigDeclaresHost,
  sshConfigHostName,
} from "./orca-doctor.mjs";

const ENVELOPE_OK = JSON.stringify({ id: "x", ok: true, result: { worktrees: [], totalCount: 0 }, _meta: {} });
const RUNTIME_LOCAL = JSON.stringify({ id: "local-status", ok: true, result: { runtime: { state: "ready", reachable: true } } });
const RUNTIME_ABSENT = JSON.stringify({ id: "local-status", ok: true, result: { runtime: { state: "stopped", reachable: false } } });
const SHIM_BREAK = "/tmp/.mount_orca-l32YWBU/orca-ide: bad option: --no-sandbox";
const BIN = "/opt/orca/orca-linux.AppImage";

/**
 * @description Builds injected deps whose `run` answers from a table keyed by "cmd arg arg".
 * Anything unlisted fails as an unclassified error, so a test can never pass by accident.
 */
function deps({ responses = {}, files = {}, environment = "", sshHost = "", env = {} } = {}) {
  const calls = [];
  return {
    calls,
    env,
    home: "/home/op",
    environment,
    sshHost,
    readFile: (p) => files[p] ?? "",
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      return responses[key] ?? { code: 1, stdout: "", stderr: "unlisted command in this fixture" };
    },
  };
}

/** A machine where the CLI works and drives its own runtime (i.e. the VPS itself). */
function vpsResponses(extra = {}) {
  return {
    [`${BIN} worktree ps --json`]: { code: 0, stdout: ENVELOPE_OK, stderr: "" },
    [`${BIN} status --json`]: { code: 0, stdout: RUNTIME_LOCAL, stderr: "" },
    [`${BIN} environment list --json`]: {
      code: 0,
      stdout: JSON.stringify({ id: "local", ok: true, result: { environments: [] } }),
      stderr: "",
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Classification — real messages, every alternative of every pattern
// ---------------------------------------------------------------------------

/**
 * Captured/observed stderr per barrier. EVERY alternative of every regex needs at least one entry:
 * the two uncovered alternatives of the sandbox pattern were exactly the ones misclassifying.
 */
const FIXTURES = {
  // One per verb in SANDBOX_VERBS — the meta-test below proves none is left unexercised. Anchoring
  // the pattern silently dropped three of these forms, and no fixture noticed.
  "sandbox-network": [
    "ssh: connect to host 100.98.45.37 port 22: Operation not permitted",
    "Error: connect EPERM 100.98.45.37:6768",
    "Failed to connect to 100.98.45.37 port 6768: Operation not permitted",
    "bind: Operation not permitted",
    "ping: sendto: Operation not permitted",
    "ping: sendmsg: Operation not permitted",
    "ping: socket: Operation not permitted",
    "Error: getaddrinfo EPERM vps.tail.ts.net",
    "ssh_exchange_identification: read: Operation not permitted",
    "Connecting to 100.98.45.37:443... failed: Operation not permitted.",
    // Go net.OpError and Node net.Socket — `read`/`write` naming a socket beyond doubt. This harness
    // is Node end to end, so `Error: write EPERM` is a form it will actually meet.
    "write tcp 10.0.0.2:5000->100.98.45.37:22: write: operation not permitted",
    "read tcp 10.0.0.2:5000->100.98.45.37:22: read: operation not permitted",
    "Error: write EPERM",
    "socket.send: Operation not permitted",
    // A host merely NAMED after the bus keeps its barrier — the veto only applies with no network
    // co-signal on the line.
    "ssh: connect to host sdbus.internal port 22: Operation not permitted",
    "ssh: connect to host dbus-vps.tail.ts.net port 22: Operation not permitted",
    "socket.error: [Errno 1] Operation not permitted",
  ],
  "known-hosts": [
    "Host key verification failed.",
    "No ED25519 host key is known for 100.98.45.37 and you have requested strict checking.",
    "@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@",
  ],
  "ssh-identity": [
    "root@100.98.45.37: Permission denied (publickey).",
    "orca@harness-vps: Permission denied (publickey,password).",
  ],
  "ssh-host-unresolved": [
    "ssh: Could not resolve hostname harness-vps: Name or service not known",
    "ssh: connect to host 100.98.45.37 port 22: No route to host",
    "ssh: connect to host 100.98.45.37 port 22: Network is unreachable",
  ],
  "unknown-environment": ['Unknown environment: "harness-vps"'],
  // Split deliberately: both alternatives of the pattern must be exercised ALONE, or one of them can
  // rot untested behind the other.
  "orca-cli-shim": ["bad option: --no-sandbox", "/tmp/.mount_orca-abc/orca-ide: bad option"],
  "orca-unknown-command": ["Unknown command: repo ls"],
  "orca-cli-missing": [
    "spawnSync /opt/orca/orca-linux.AppImage ENOENT",
    "/bin/sh: 1: orca: command not found",
  ],
};

test("every barrier classifies EVERY message form it claims to cover", () => {
  for (const barrier of BARRIERS) {
    const messages = FIXTURES[barrier.id];
    assert.ok(messages?.length, `no fixtures for barrier "${barrier.id}"`);
    for (const message of messages) {
      assert.equal(
        classifyFailure(message)?.id,
        barrier.id,
        `"${message}" should classify as ${barrier.id}, got ${classifyFailure(message)?.id ?? "null"}`,
      );
    }
  }
  assert.equal(classifyFailure(""), null, "empty output must not be guessed at");
  assert.equal(classifyFailure("some brand new failure"), null, "an unknown failure is reported, not invented");
});

test("every verb the sandbox pattern claims has a fixture — as a TOKEN, not as a substring", () => {
  // Matching the fixture with a bare substring here would repeat production's own bug: accidental
  // coverage (`read` inside `already`) would read as a covered verb. The fixture must carry the verb
  // the way a denied syscall names itself.
  for (const verb of SANDBOX_VERBS) {
    const asToken = new RegExp(`\\b${verb}\\b\\s*(?::|\\(|\\s+to\\b|\\s+EPERM\\b)`, "i");
    const covered = FIXTURES["sandbox-network"].filter((m) => asToken.test(m));
    assert.ok(covered.length > 0, `no fixture exercises the "${verb}" verb as a syscall token`);
    for (const message of covered) assert.equal(classifyFailure(message)?.id, "sandbox-network");
  }
});

test("an ordinary filesystem denial is NOT the network sandbox — the verbs are substrings of real words", () => {
  // Every one of these classified as sandbox-network when the verbs were joined without a qualifier,
  // answering a permission error on a FILE with "disable the sandbox". `already` and `pthread`
  // contain `read`; `docker.socket` contains `socket`; `write-cache` contains `write`.
  const filesystem = [
    "tar: ./read-only-dir: Cannot mkdir: Operation not permitted",
    "chown: /home/x/.cache/write-cache: Operation not permitted",
    "rm: cannot remove '/var/run/docker.socket': Operation not permitted",
    "setfacl: /etc/NetworkManager/connections/wifi: Operation not permitted",
    "ln: '/usr/bin/bindfs': Operation not permitted",
    "git: index already locked; chmod .git/index.lock: Operation not permitted",
    "pthread_create: Operation not permitted",
    // `strace` is what someone runs WHILE investigating a permission error — answering it with
    // "disable the sandbox" is the worst possible moment to be wrong. These are file descriptors.
    "read(3, 0x7ffd, 4096) = -1 EPERM (Operation not permitted)",
    "write(2, 0x55a0, 12) = -1 EPERM (Operation not permitted)",
    "tar: /var/log/audit/audit.log: Cannot read: Operation not permitted",
    "dd: failed to open '/dev/sda' for read: Operation not permitted",
    // sd-bus is D-Bus by another name — and carries no port, no IP and no `tcp`, which is exactly
    // what separates it from a host that happens to be called `sdbus.internal`.
    "sd_bus_open_system: connect: Operation not permitted",
    "dbus[1]: Operation not permitted",
    // A systemd unit path ends in `.socket` with no method after it.
    "chmod: changing permissions of '/etc/systemd/system/x.socket': Operation not permitted",
    // A socket EXCEPTION is not a socket denial: a timeout, a DNS failure and a close are not the
    // sandbox, and answering them with "disable the sandbox" is advice that cannot help.
    "socket.timeout: The read operation timed out; cleanup failed: Operation not permitted",
    "socket.gaierror: [Errno -2] Name or service not known; chmod: Operation not permitted",
    "java.net.SocketException: socket.close: Operation not permitted",
    // D-Bus over TCP carries a `tcp` AND an IP and is still D-Bus — the co-signal has to be a co-signal
    // of a remote CONNECTION (`port 22`, with a space), not of the word `tcp`.
    "dbus[1]: Unable to connect to tcp:host=100.98.45.37,port=5555: Operation not permitted",
    "Failed to connect to bus tcp:host=localhost,port=55556: Operation not permitted",
    // Real file-write denials from the tools that emit them.
    "dd: writing to '/dev/sda': Operation not permitted",
    'rsync: write failed on "/mnt/x": Operation not permitted (1)',
  ];
  for (const message of filesystem) {
    const barrier = classifyFailure(message);
    assert.notEqual(
      barrier?.id,
      "sandbox-network",
      `a file-permission error must not prescribe disabling the sandbox: ${message}`,
    );
  }
});

test("the D-Bus veto is anchored — a host merely NAMED bus keeps its barrier", () => {
  assert.equal(
    classifyFailure("curl: (7) Failed to connect to bus.example.com port 443: Operation not permitted")?.id,
    "sandbox-network",
    "vetoing on the substring `to bus` silently deleted the diagnosis for any host starting with bus",
  );
});

test("D-Bus speaks the same words and is NOT the network sandbox", () => {
  // `systemctl --user` on a machine with no session bus produces this constantly. Prescribing
  // "disable the sandbox" for it is advice that cannot possibly help.
  assert.equal(classifyFailure("systemd[1]: Failed to connect to bus: Operation not permitted"), null);
  assert.equal(classifyFailure("Failed to connect to D-Bus: Operation not permitted"), null);
});

test("the sandbox barrier is ANCHORED to a connection attempt — it must not hijack unrelated stderr", () => {
  // Real ssh output when the key file is unreadable: it contains the words "Operation not permitted"
  // and has nothing to do with the sandbox. Prescribing "turn the sandbox off" here is a security
  // downgrade recommended for the wrong cause.
  const identityFile = [
    "Load key \"/home/op/.ssh/id_vps\": Operation not permitted",
    "root@100.98.45.37: Permission denied (publickey).",
  ].join("\n");
  assert.equal(classifyFailure(identityFile).id, "ssh-identity");

  const unrelatedEperm = 'EPERM: operation not permitted, open \'/etc/hosts\'\nUnknown environment: "vps"';
  assert.equal(
    classifyFailure(unrelatedEperm).id,
    "unknown-environment",
    "a file-permission EPERM must not outrank the real diagnosis in the same output",
  );
});

test("the unreachable-network family lands on ONE fix, not two contradictory ones", () => {
  const family = [
    "ssh: connect to host 100.98.45.37 port 22: No route to host",
    "ssh: connect to host 100.98.45.37 port 22: Network is unreachable",
    "ssh: Could not resolve hostname harness-vps: Name or service not known",
  ].map((m) => classifyFailure(m));
  assert.equal(new Set(family.map((b) => b.id)).size, 1, "same root cause, same barrier");
  assert.equal(family[0].id, "ssh-host-unresolved");
});

test("every barrier carries a cause AND a fix — a diagnosis with no repair is what cost the session", () => {
  for (const b of BARRIERS) {
    assert.ok(b.cause.trim().length > 10, `${b.id} needs a cause`);
    assert.ok(b.fix.trim().length > 10, `${b.id} needs a fix`);
    assert.ok(b.readsAs.trim().length > 3, `${b.id} needs the wrong reading it produces`);
    assert.ok(b.docToken.trim().length > 3, `${b.id} needs the token the playbook row must carry`);
  }
});

// ---------------------------------------------------------------------------
// Envelope + candidates
// ---------------------------------------------------------------------------

test("readEnvelope separates a refusal (ok:false) from an unreadable answer, and survives a banner", () => {
  const refusal = readEnvelope(JSON.stringify({ id: "local", ok: false, error: { message: "Unknown command: repo ls" } }));
  assert.deepEqual(
    { readable: refusal.readable, ok: refusal.ok, msg: refusal.errorMessage },
    { readable: true, ok: false, msg: "Unknown command: repo ls" },
  );
  assert.equal(readEnvelope("not json at all").readable, false);
  assert.equal(readEnvelope("[]").readable, false, "an array is not an envelope");
  assert.equal(readEnvelope("5").readable, false);
  assert.equal(readEnvelope(ENVELOPE_OK).ok, true);
  assert.equal(readEnvelope(`[dbus] noise\n${ENVELOPE_OK}`).ok, true, "a wrapper banner must not read as a dead CLI");
});

test("ORCA_BIN is honored first, and the default candidates are never duplicated", () => {
  assert.deepEqual(orcaCandidates({ ORCA_BIN: BIN }), [BIN, "orca"]);
  assert.equal(orcaCandidates({ ORCA_BIN: "/custom/orca" })[0], "/custom/orca");
  assert.deepEqual(orcaCandidates({}), [BIN, "orca"]);
});

test("a broken PATH shim does not hide a working AppImage — probe by asking a real question", async () => {
  const d = deps({
    env: { ORCA_BIN: "orca" }, // the shim first, exactly as a PATH-first probe would find it
    responses: {
      "orca worktree ps --json": { code: 9, stdout: "", stderr: SHIM_BREAK },
      [`${BIN} worktree ps --json`]: { code: 0, stdout: ENVELOPE_OK, stderr: "" },
    },
  });
  const result = await probeOrcaBin(d);
  assert.equal(result.status, "ok");
  assert.equal(result.bin, BIN);
  assert.equal(result.attempts[0].barrier.id, "orca-cli-shim", "the shim break must be recorded, not swallowed");
});

test("a CLI that ANSWERS with ok:false is usable — a refusal is not a dead binary", async () => {
  const d = deps({
    responses: {
      [`${BIN} worktree ps --json`]: {
        code: 1,
        stdout: JSON.stringify({ id: "local", ok: false, error: { message: "Unknown command: worktree ps" } }),
        stderr: "",
      },
    },
  });
  const result = await probeOrcaBin(d);
  assert.equal(result.status, "ok");
  assert.match(result.refusal, /Unknown command/);
});

test("no Orca installed — the normal laptop — is a named barrier with a fix, not an unclassified failure", async () => {
  const d = deps({
    responses: {
      [`${BIN} worktree ps --json`]: { code: 1, stdout: "", stderr: `spawnSync ${BIN} ENOENT` },
      "orca worktree ps --json": { code: 127, stdout: "", stderr: "/bin/sh: 1: orca: command not found" },
    },
  });
  const report = await diagnose(d);
  assert.equal(report.ok, false);
  assert.deepEqual(report.barriers.map((b) => b.id), ["orca-cli-missing"]);
  assert.match(report.verdict, /NÃO é falta de acesso/);
  assert.match(renderReport(report), /ORCA_BIN/, "the fix must reach the operator");
});

// ---------------------------------------------------------------------------
// The verdict may only claim what a probe returned
// ---------------------------------------------------------------------------

test("a working local CLI with NO paired environment must not be reported as reaching the VPS", async () => {
  const d = deps({ responses: vpsResponses() });
  const report = await diagnose(d);
  assert.doesNotMatch(
    report.verdict,
    /tudo que é do Orca vai por --environment/,
    "claiming the --environment shortcut with zero environments paired is the incident inverted",
  );
  assert.match(report.verdict, /runtime desta MÁQUINA/);
  assert.equal(report.environment.status, "none");
});

test("a proven round-trip is the only thing that earns the 'operável' claim", async () => {
  const d = deps({
    environment: "harness-vps",
    responses: vpsResponses({
      [`${BIN} status --environment harness-vps --json`]: {
        code: 0,
        stdout: JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "ready", reachable: true } } }),
        stderr: "",
      },
    }),
  });
  const report = await diagnose(d);
  assert.equal(report.ok, true);
  assert.match(report.verdict, /Operável: o ambiente "harness-vps" respondeu/);
});

test("a paired-but-unreachable environment is NOT operable, and says so", async () => {
  const d = deps({
    environment: "harness-vps",
    responses: {
      [`${BIN} worktree ps --json`]: { code: 0, stdout: ENVELOPE_OK, stderr: "" },
      [`${BIN} status --json`]: { code: 0, stdout: RUNTIME_ABSENT, stderr: "" },
      [`${BIN} status --environment harness-vps --json`]: {
        code: 0,
        stdout: JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "starting", reachable: false } } }),
        stderr: "",
      },
    },
  });
  const report = await diagnose(d);
  assert.equal(report.ok, false, "a CLI that answers is not a VPS that answers");
  assert.equal(report.environment.status, "unreachable");
});

test("an environment barrier is never reported as an SSH barrier", async () => {
  const d = deps({
    environment: "harness-vps",
    sshHost: "harness-vps",
    responses: {
      [`${BIN} worktree ps --json`]: { code: 0, stdout: ENVELOPE_OK, stderr: "" },
      [`${BIN} status --json`]: { code: 0, stdout: RUNTIME_ABSENT, stderr: "" },
      [`${BIN} status --environment harness-vps --json`]: {
        code: 1,
        stdout: JSON.stringify({ id: "local", ok: false, error: { message: 'Unknown environment: "harness-vps"' } }),
        stderr: "",
      },
      "ssh -o BatchMode=yes -o ConnectTimeout=5 harness-vps true": {
        code: 255,
        stdout: "",
        stderr: "Host key verification failed.",
      },
    },
  });
  const report = await diagnose(d);
  assert.deepEqual(report.orcaBarriers.map((b) => b.id), ["unknown-environment"]);
  assert.deepEqual(report.sshBarriers.map((b) => b.id), ["known-hosts"]);
  assert.doesNotMatch(
    report.verdict,
    /SSH bloqueado por:[^.]*unknown-environment/,
    "attributing an environment failure to SSH sends the operator to repair the wrong thing",
  );
});

test("NO verdict ever tells the caller it lacks access — that conclusion is the bug", () => {
  const combos = [
    { cliOk: false, localOpen: false, remoteOpen: false, sshOpen: false, environment: {}, orcaBarriers: [BARRIERS[0]], sshBarriers: [BARRIERS[2]] },
    { cliOk: false, localOpen: false, remoteOpen: false, sshOpen: false, environment: {}, orcaBarriers: [], sshBarriers: [] },
    { cliOk: true, localOpen: false, remoteOpen: false, sshOpen: false, environment: { status: "none" }, orcaBarriers: [], sshBarriers: [] },
    { cliOk: true, localOpen: true, remoteOpen: false, sshOpen: false, environment: { status: "none" }, orcaBarriers: [], sshBarriers: [BARRIERS[1]] },
    { cliOk: true, localOpen: false, remoteOpen: true, sshOpen: true, environment: { status: "ok", environment: "vps" }, orcaBarriers: [], sshBarriers: [] },
    { cliOk: false, localOpen: false, remoteOpen: false, sshOpen: true, environment: {}, orcaBarriers: [], sshBarriers: [] },
  ];
  for (const combo of combos) {
    const verdict = buildVerdict(combo);
    assert.doesNotMatch(verdict, /sem acesso|não tenho acesso|no access/i, `verdict claimed missing access: "${verdict}"`);
    assert.ok(verdict.trim().length > 20);
  }
  assert.match(buildVerdict(combos[0]), /NÃO é falta de acesso/, "the wrong reading must be refuted explicitly");
  assert.match(buildVerdict(combos[1]), /reporte a saída bruta/i);
  assert.match(buildVerdict(combos[2]), /reporte a saída bruta/i, "a CLI that answers is not a path that opened");
});

// ---------------------------------------------------------------------------
// SSH probe
// ---------------------------------------------------------------------------

test("probeSsh maps each ssh failure to its own fix, and never auto-trusts the host", async () => {
  const cases = [
    ["root@vps: Permission denied (publickey).", "ssh-identity", /IdentitiesOnly/],
    ["Host key verification failed.", "known-hosts", /ssh-keyscan/],
    ["ssh: connect to host 100.98.45.37 port 22: Operation not permitted", "sandbox-network", /sandbox/],
  ];
  for (const [stderr, id, fixRe] of cases) {
    const d = deps({
      sshHost: "harness-vps",
      responses: { "ssh -o BatchMode=yes -o ConnectTimeout=5 harness-vps true": { code: 255, stdout: "", stderr } },
    });
    const result = await probeSsh(d);
    assert.equal(result.status, "blocked");
    assert.equal(result.barrier.id, id);
    assert.match(result.barrier.fix, fixRe);
    assert.ok(
      !d.calls.some((c) => /StrictHostKeyChecking/.test(c)),
      "the probe must not accept host keys for the operator — that would mask barrier 2",
    );
  }
});

test("an alias that ssh would read as an OPTION is refused without running anything", async () => {
  // `ssh -oProxyCommand=… true` executes a command. A read-only diagnosis must never become an
  // execution primitive because someone passed a flag-shaped alias (or set HARNESS_VPS_SSH_HOST).
  for (const hostile of ["-oProxyCommand=sh -c 'id'", "--", "-l", "host;id", "host$(id)", "a b"]) {
    const d = deps({ sshHost: hostile });
    const result = await probeSsh(d);
    assert.equal(result.status, "skipped", `"${hostile}" must not be probed`);
    assert.match(result.reason, /inválido/);
    assert.deepEqual(d.calls, [], "nothing may be executed for a refused alias");
  }
  assert.equal(isSafeHost("harness-vps"), true);
  assert.equal(isSafeHost("root@100.98.45.37"), true);
  assert.equal(isSafeHost("-oProxyCommand=x"), false);
});

test("the guard accepts the tailnet's own IPv6 — refusing it refuses the network it exists to reach", () => {
  // Tailscale gives EVERY node an address in fd7a:115c:a1e0::/48. The first guard rejected all of
  // them, silently dropping the only path the operator had asked for: not running the wrong thing,
  // but running nothing and reporting a path that was never probed.
  for (const addr of ["fd7a:115c:a1e0::3f1", "[fd7a:115c:a1e0::3f1]", "fe80::1%tailscale0", "root@fd7a:115c:a1e0::3f1", "::1"]) {
    assert.equal(isSafeHost(addr), true, `${addr} is a destination ssh accepts`);
  }
  assert.equal(isSafeHost("-fd7a::1"), false, "a leading dash is still an option, not an address");
});

test("an environment NAME is a human field, not a hostname — the wrong guard degraded the verdict", () => {
  for (const name of ["harness-vps", "vps são paulo", "_prod", "VPS 2 (staging)"]) {
    assert.equal(isSafeEnvironmentName(name), true, `${name} is a legitimate --name value`);
  }
  for (const name of ["", "   ", "-o something", "a\nb"]) {
    assert.equal(isSafeEnvironmentName(name), false);
  }
});

test("a glob Host block declares the host — `Host harness-*` is the ordinary way to write a tailnet config", () => {
  const glob = "Host harness-*\n  HostName 100.98.45.37\n  IdentitiesOnly yes\n";
  assert.equal(sshConfigDeclaresHost(glob, "harness-vps"), true);
  assert.equal(sshConfigHostName(glob, "harness-vps"), "100.98.45.37");
  assert.equal(sshConfigDeclaresHost(glob, "other-box"), false);

  // A `Match` block's condition is not statically resolvable, so "not declared" becomes unsayable.
  assert.equal(sshConfigDeclaresHost("Match host harness-vps\n  User root\n", "harness-vps"), true);

  // ssh semantics: a matching negated pattern EXCLUDES the host from the block.
  assert.equal(sshConfigDeclaresHost("Host *-vps !harness-vps\n  User root\n", "harness-vps"), false);
  assert.equal(sshConfigDeclaresHost("Host *-vps !other-vps\n  User root\n", "harness-vps"), true);

  // `%h` is expanded by ssh at connect time; returning it literally is a hostname that exists nowhere.
  assert.equal(sshConfigHostName("Host harness-vps\n  HostName %h.tail.ts.net\n", "harness-vps"), "");
});

test("known_hosts is compared against the resolved HostName, not the alias ssh never stores", () => {
  const config = "Host harness-vps\n  HostName 100.98.45.37\n  IdentitiesOnly yes\n";
  assert.equal(sshConfigHostName(config, "harness-vps"), "100.98.45.37");
  assert.equal(sshConfigHostName(config, "other"), "");
  // The real file holds the IP; asking for the alias alone would have invented barrier 2 here.
  assert.equal(knownHostsCovers("100.98.45.37 ssh-ed25519 AAAA", ["100.98.45.37", "harness-vps"]), "yes");
  assert.equal(knownHostsCovers("|1|abc=|def= ssh-ed25519 AAAA", ["100.98.45.37", "harness-vps"]), "unknown");
  assert.equal(knownHostsCovers("other-host ssh-ed25519 AAAA", ["100.98.45.37", "harness-vps"]), "no");
  assert.equal(knownHostsCovers("", ["harness-vps"]), "no");
});

test("sshConfigDeclaresHost matches an alias among several on one Host line, not a substring", () => {
  const config = "Host harness-vps vps\n  HostName 100.98.45.37\n  IdentitiesOnly yes\n";
  assert.equal(sshConfigDeclaresHost(config, "vps"), true);
  assert.equal(sshConfigDeclaresHost(config, "harness-vps"), true);
  assert.equal(sshConfigDeclaresHost(config, "harness"), false);
  assert.equal(sshConfigDeclaresHost("", "harness-vps"), false);
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test("probeEnvironment with no name reports what IS paired — an empty list is a step, not a barrier", async () => {
  const d = deps({
    responses: {
      [`${BIN} environment list --json`]: {
        code: 0,
        stdout: JSON.stringify({ id: "local", ok: true, result: { environments: [] } }),
        stderr: "",
      },
    },
  });
  assert.deepEqual(await probeEnvironment(d, BIN), { status: "none", environments: [] });
});

test("the capability split never claims SSH-only work can be done over --environment", () => {
  const viaEnv = CAPABILITIES.viaEnvironment.join(" ");
  for (const needle of ["crontab", "systemctl", ".config/claude-harness"]) {
    assert.ok(!viaEnv.includes(needle), `"${needle}" is machine state — it cannot be claimed for --environment`);
  }
  assert.ok(CAPABILITIES.requiresSsh.some((c) => c.includes("crontab")));
  assert.ok(CAPABILITIES.viaEnvironment.every((c) => c.includes("--environment")));
});

test("diagnose composes the probes and renders every barrier with its fix", async () => {
  const d = deps({
    environment: "harness-vps",
    sshHost: "harness-vps",
    responses: vpsResponses({
      [`${BIN} status --environment harness-vps --json`]: {
        code: 0,
        stdout: JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "ready", reachable: true } } }),
        stderr: "",
      },
      "ssh -o BatchMode=yes -o ConnectTimeout=5 harness-vps true": {
        code: 255,
        stdout: "",
        stderr: "Host key verification failed.",
      },
    }),
  });
  const report = await diagnose(d);
  assert.equal(report.ok, true, "the environment round-trip is an open path");
  assert.equal(report.environment.status, "ok");
  assert.deepEqual(report.barriers.map((b) => b.id), ["known-hosts"]);

  const text = renderReport(report);
  assert.match(text, /ssh-keyscan/, "the rendered report must carry the fix, not only the symptom");
  assert.match(text, /--environment/, "the report must carry the split that dispenses with SSH");
  assert.doesNotMatch(text, /sem acesso/i);
});

test("parseDoctorArgs", () => {
  assert.deepEqual(parseDoctorArgs(["--environment", "harness-vps", "--ssh-host", "vps", "--json"]), {
    environment: "harness-vps",
    sshHost: "vps",
    json: true,
  });
  assert.deepEqual(parseDoctorArgs([]), { environment: "", sshHost: "", json: false });
});

test("the veto is judged on the line that matched, not on the whole blob", () => {
  // The hook classifies arbitrary multi-line Bash output. With the veto evaluated over the blob, a
  // stray IP on an unrelated line lifted the veto of a line that was not its own — pure D-Bus noise
  // read as a sandbox denial.
  assert.notEqual(
    classifyFailure("dbus[1]: Failed to bind: Operation not permitted\nRunning on 100.98.45.37")?.id,
    "sandbox-network",
  );
  assert.notEqual(
    classifyFailure("Failed to connect to bus: Operation not permitted\nlistening on port 8080")?.id,
    "sandbox-network",
  );

  // …and the symmetric failure the line-scoped rule must NOT introduce: a real denial that arrives
  // after D-Bus noise still classifies.
  assert.equal(
    classifyFailure(
      "dbus[1]: Failed to connect to bus: Operation not permitted\nssh: connect to host 100.98.45.37 port 22: Operation not permitted",
    )?.id,
    "sandbox-network",
  );
  assert.equal(
    classifyFailure("systemd[1]: Failed to connect to bus: Operation not permitted\nUnknown environment: \"vps\"")?.id,
    "unknown-environment",
  );
});
