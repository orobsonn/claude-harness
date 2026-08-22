/**
 * @description Frozen oracle for orca-doctor. Every seam injected — ZERO real CLI, ssh, or fs.
 *
 * What it pins is the defect the module exists for: three failures whose messages read as "no access"
 * (`Permission denied (publickey)`, `Host key verification failed`, `Operation not permitted`) made an
 * agent stop and hand the work back to the operator, while another session on the same machine, in the
 * same minute, operated the VPS fine. So the assertions here are not "the probe runs" — they are
 * (a) each message resolves to ITS barrier and ITS fix, (b) a usable path is found even when the first
 * candidate binary is broken, and (c) NO verdict, in any blocked combination, ever states that access
 * is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BARRIERS,
  CAPABILITIES,
  buildVerdict,
  classifyFailure,
  diagnose,
  knownHostsCovers,
  orcaCandidates,
  parseDoctorArgs,
  probeEnvironment,
  probeOrcaBin,
  probeSsh,
  readEnvelope,
  renderReport,
  sshConfigDeclaresHost,
} from "./orca-doctor.mjs";

const ENVELOPE_OK = JSON.stringify({ id: "x", ok: true, result: { worktrees: [], totalCount: 0 }, _meta: {} });
const SHIM_BREAK = "/tmp/.mount_orca-l32YWBU/orca-ide: bad option: --no-sandbox";

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

test("every barrier in the table classifies its own canonical message", () => {
  const cases = {
    "sandbox-network": "ssh: connect to host 100.98.45.37 port 22: Operation not permitted",
    "known-hosts": "Host key verification failed.",
    "ssh-identity": "root@100.98.45.37: Permission denied (publickey).",
    "ssh-host-unresolved": "ssh: Could not resolve hostname harness-vps: Name or service not known",
    "unknown-environment": 'Unknown environment: "harness-vps"',
    "orca-cli-shim": SHIM_BREAK,
    "orca-unknown-command": "Unknown command: repo ls",
  };
  for (const barrier of BARRIERS) {
    const message = cases[barrier.id];
    assert.ok(message, `no canonical message fixture for barrier "${barrier.id}"`);
    assert.equal(classifyFailure(message).id, barrier.id);
  }
  assert.equal(classifyFailure(""), null, "empty output must not be guessed at");
  assert.equal(classifyFailure("some brand new failure"), null, "an unknown failure is reported, not invented");
});

test("every barrier carries a cause AND a fix — a diagnosis with no repair is what cost the session", () => {
  for (const b of BARRIERS) {
    assert.ok(b.cause.trim().length > 10, `${b.id} needs a cause`);
    assert.ok(b.fix.trim().length > 10, `${b.id} needs a fix`);
    assert.ok(b.readsAs.trim().length > 3, `${b.id} needs the wrong reading it produces`);
    assert.ok(b.docToken.trim().length > 3, `${b.id} needs the token the playbook row must carry`);
  }
});

test("the sandbox barrier is classified BEFORE the ssh ones — it denies before the packet leaves the machine", () => {
  assert.equal(
    classifyFailure("Operation not permitted\nPermission denied (publickey).").id,
    "sandbox-network",
    "an outer denial must not be reported as a key problem underneath it",
  );
});

test("readEnvelope separates a refusal (ok:false) from an unreadable answer", () => {
  const refusal = readEnvelope(JSON.stringify({ id: "local", ok: false, error: { message: "Unknown command: repo ls" } }));
  assert.deepEqual(
    { readable: refusal.readable, ok: refusal.ok, msg: refusal.errorMessage },
    { readable: true, ok: false, msg: "Unknown command: repo ls" },
  );
  assert.equal(readEnvelope("not json at all").readable, false);
  assert.equal(readEnvelope(ENVELOPE_OK).ok, true);
});

test("ORCA_BIN is honored first, and the default candidates are never duplicated", () => {
  assert.deepEqual(orcaCandidates({ ORCA_BIN: "/opt/orca/orca-linux.AppImage" }), ["/opt/orca/orca-linux.AppImage", "orca"]);
  assert.deepEqual(orcaCandidates({ ORCA_BIN: "/custom/orca" })[0], "/custom/orca");
  assert.deepEqual(orcaCandidates({}), ["/opt/orca/orca-linux.AppImage", "orca"]);
});

test("a broken PATH shim does not hide a working AppImage — probe by asking a real question", async () => {
  const d = deps({
    env: { ORCA_BIN: "orca" }, // the shim first, exactly as a PATH-first probe would find it
    responses: {
      "orca worktree ps --json": { code: 9, stdout: "", stderr: SHIM_BREAK },
      "/opt/orca/orca-linux.AppImage worktree ps --json": { code: 0, stdout: ENVELOPE_OK, stderr: "" },
    },
  });
  const result = await probeOrcaBin(d);
  assert.equal(result.status, "ok");
  assert.equal(result.bin, "/opt/orca/orca-linux.AppImage");
  assert.equal(result.attempts[0].barrier.id, "orca-cli-shim", "the shim break must be recorded, not swallowed");
});

test("a CLI that ANSWERS with ok:false is usable — a refusal is not a dead binary", async () => {
  const d = deps({
    responses: {
      "/opt/orca/orca-linux.AppImage worktree ps --json": {
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

test("probeEnvironment: a lost pairing is named as such, with the restart+re-pair fix", async () => {
  const d = deps({
    environment: "harness-vps",
    responses: {
      "/opt/orca/orca-linux.AppImage status --environment harness-vps --json": {
        code: 1,
        stdout: JSON.stringify({ id: "local", ok: false, error: { message: 'Unknown environment: "harness-vps"' } }),
        stderr: "",
      },
    },
  });
  const result = await probeEnvironment(d, "/opt/orca/orca-linux.AppImage");
  assert.equal(result.status, "blocked");
  assert.equal(result.barrier.id, "unknown-environment");
  assert.match(result.barrier.fix, /systemctl restart orca-serve/);
});

test("probeEnvironment: a real round-trip reads reachable/state out of the envelope's result", async () => {
  const d = deps({
    environment: "harness-vps",
    responses: {
      "/opt/orca/orca-linux.AppImage status --environment harness-vps --json": {
        code: 0,
        stdout: JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "ready", reachable: true } } }),
        stderr: "",
      },
    },
  });
  const result = await probeEnvironment(d, "/opt/orca/orca-linux.AppImage");
  assert.deepEqual({ status: result.status, state: result.state }, { status: "ok", state: "ready" });
});

test("probeEnvironment with no name reports what IS paired — an empty list is a step, not a barrier", async () => {
  const d = deps({
    responses: {
      "/opt/orca/orca-linux.AppImage environment list --json": {
        code: 0,
        stdout: JSON.stringify({ id: "local", ok: true, result: { environments: [] } }),
        stderr: "",
      },
    },
  });
  const result = await probeEnvironment(d, "/opt/orca/orca-linux.AppImage");
  assert.deepEqual(result, { status: "none", environments: [] });
});

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

test("known_hosts written by `ssh-keyscan -H` is opaque, so absence is 'unknown', never 'missing'", () => {
  assert.equal(knownHostsCovers("|1|abc=|def= ssh-ed25519 AAAA", "harness-vps"), "unknown");
  assert.equal(knownHostsCovers("harness-vps,100.98.45.37 ssh-ed25519 AAAA", "harness-vps"), "yes");
  assert.equal(knownHostsCovers("other-host ssh-ed25519 AAAA", "harness-vps"), "no");
  assert.equal(knownHostsCovers("", "harness-vps"), "no");
});

test("sshConfigDeclaresHost matches an alias among several on one Host line, not a substring", () => {
  const config = "Host harness-vps vps\n  HostName 100.98.45.37\n  IdentitiesOnly yes\n";
  assert.equal(sshConfigDeclaresHost(config, "vps"), true);
  assert.equal(sshConfigDeclaresHost(config, "harness-vps"), true);
  assert.equal(sshConfigDeclaresHost(config, "harness"), false);
  assert.equal(sshConfigDeclaresHost("", "harness-vps"), false);
});

test("NO verdict ever tells the caller it lacks access — that conclusion is the bug", () => {
  const combos = [
    { orcaOpen: false, sshOpen: false, environment: {}, barriers: [BARRIERS[0], BARRIERS[2]] },
    { orcaOpen: false, sshOpen: false, environment: {}, barriers: [] },
    { orcaOpen: true, sshOpen: false, environment: {}, barriers: [BARRIERS[1]] },
    { orcaOpen: false, sshOpen: true, environment: {}, barriers: [] },
    { orcaOpen: true, sshOpen: true, environment: {}, barriers: [] },
  ];
  for (const combo of combos) {
    const verdict = buildVerdict(combo);
    assert.doesNotMatch(verdict, /sem acesso|não tenho acesso|no access/i, `verdict claimed missing access: "${verdict}"`);
    assert.ok(verdict.trim().length > 20);
  }
  assert.match(buildVerdict(combos[0]), /NÃO é falta de acesso/, "the wrong reading must be refuted explicitly");
  assert.match(
    buildVerdict(combos[1]),
    /reporte a saída bruta/i,
    "with no recognized barrier the raw output goes to the operator — the agent still must not conclude",
  );
});

test("the capability split never claims SSH-only work can be done over --environment", () => {
  const viaEnv = CAPABILITIES.viaEnvironment.join(" ");
  for (const needle of ["crontab", "systemctl", ".config/claude-harness"]) {
    assert.ok(!viaEnv.includes(needle), `"${needle}" is machine state — it cannot be claimed for --environment`);
  }
  assert.ok(CAPABILITIES.requiresSsh.some((c) => c.includes("crontab")));
  assert.ok(CAPABILITIES.viaEnvironment.every((c) => c.includes("--environment")));
});

test("diagnose composes the three probes and renders every barrier with its fix", async () => {
  const d = deps({
    environment: "harness-vps",
    sshHost: "harness-vps",
    responses: {
      "/opt/orca/orca-linux.AppImage worktree ps --json": { code: 0, stdout: ENVELOPE_OK, stderr: "" },
      "/opt/orca/orca-linux.AppImage status --environment harness-vps --json": {
        code: 0,
        stdout: JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "ready", reachable: true } } }),
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
  assert.equal(report.ok, true, "one open path is enough to be operable");
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
