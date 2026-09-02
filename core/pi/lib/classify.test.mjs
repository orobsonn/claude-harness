/** @description Testes da classify da lane Pi — espelham os casos da lane OC
 * (core/opencode/tools/lib/stable-classify.test.mjs + classify-persist.test.mjs), com a raiz
 * `.pi/harness/` no lugar de `.opencode/plans/` e a autoridade derivada de isChild. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executePiClassify,
  piClassifyChildDenyReason,
  piClassifyErrorResult,
} from "./classify.mjs";
import { decideClassifyAuthority } from "../../shared/lib/classify-authority.mjs";

const SESSION = "01HZPI-classify-0001";

/** @description Cria uma raiz de projeto temporária isolada por teste. */
function mkRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-classify-${label}-`));
}

/** @description Caminho do gate-state da lane Pi para a sessão do teste. */
function statePathOf(root, sessionId = SESSION) {
  return path.join(root, ".pi", "harness", "state", sessionId, "gate-state.json");
}

/** @description Lê o gate-state persistido como objeto. */
function readState(root, sessionId = SESSION) {
  return JSON.parse(fs.readFileSync(statePathOf(root, sessionId), "utf8"));
}

/** @description Extrai o payload de details e confere que content[0].text é o mesmo JSON. */
function payloadOf(result) {
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  return result.details;
}

/** @description Roda uma classify contra a raiz temporária. */
function classify(root, mode, featureId, opts = {}) {
  return executePiClassify(
    { mode, feature_id: featureId },
    {
      projectRoot: root,
      sessionId: opts.sessionId ?? SESSION,
      isChild: opts.isChild === true,
    },
    opts.deps ?? {},
  );
}

for (const mode of ["no-ceremony", "QUICK", "LIGHT", "FULL"]) {
  test(`classify ${mode} persiste triagem sob .pi/harness/state e devolve o plano estável`, () => {
    const root = mkRoot("mode");
    try {
      const payload = payloadOf(classify(root, mode, "pi-feature"));

      assert.deepEqual(payload, {
        plan_path: path.join(root, ".pi/harness/plans/pi-feature/execution-plan.json"),
        mode,
        feature_id: "pi-feature",
        action: "fresh",
        peak_mode: mode,
      });
      assert.deepEqual(readState(root), {
        session_id: SESSION,
        feature_id: "pi-feature",
        mode,
        peak_mode: mode,
        classified: true,
        triaged: true,
      });
      // classify NUNCA cria plano.
      assert.equal(fs.existsSync(path.join(root, ".pi/harness/plans")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("plan_path é estável entre sessões diferentes para a mesma feature", () => {
  const root = mkRoot("stable");
  try {
    const first = payloadOf(classify(root, "LIGHT", "stable-feature", { sessionId: "ses-first" }));
    const second = payloadOf(classify(root, "LIGHT", "stable-feature", { sessionId: "ses-second" }));
    assert.equal(first.plan_path, `${root}/.pi/harness/plans/stable-feature/execution-plan.json`);
    assert.equal(second.plan_path, first.plan_path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("escalada QUICK → FULL é permitida e sobe o peak_mode", () => {
  const root = mkRoot("escalate");
  try {
    classify(root, "QUICK", "pi-feature");
    const payload = payloadOf(classify(root, "FULL", "pi-feature"));

    assert.equal(payload.action, "escalate");
    assert.equal(payload.mode, "FULL");
    assert.equal(payload.peak_mode, "FULL");
    const state = readState(root);
    assert.equal(state.mode, "FULL");
    assert.equal(state.peak_mode, "FULL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebaixamento FULL → QUICK é negado com a mensagem da lane OC", () => {
  const root = mkRoot("downgrade");
  try {
    classify(root, "FULL", "pi-feature");
    const payload = payloadOf(classify(root, "QUICK", "pi-feature"));

    assert.deepEqual(payload, {
      error: "downgrade denied — mode is FULL; cannot reclassify to QUICK",
      hint: "classify is escalate-only for an active session+feature; never downgrade or switch feature mid-run",
      received: JSON.stringify({ mode: "QUICK", feature_id: "pi-feature" }),
    });
    // Estado intacto no modo alto.
    assert.equal(readState(root).mode, "FULL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("troca de feature no meio da run é negada", () => {
  const root = mkRoot("switch");
  try {
    classify(root, "LIGHT", "pi-feature");
    const payload = payloadOf(classify(root, "LIGHT", "outra-feature"));

    assert.equal(
      payload.error,
      "feature switch denied — start a new session for a different feature_id",
    );
    assert.equal(readState(root).feature_id, "pi-feature");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no-ceremony não fixa feature_id — a próxima feature é fresh", () => {
  const root = mkRoot("unbound");
  try {
    classify(root, "no-ceremony", "chat-only");
    const payload = payloadOf(classify(root, "FULL", "pi-feature"));

    assert.equal(payload.action, "fresh");
    assert.equal(payload.feature_id, "pi-feature");
    assert.equal(payload.peak_mode, "FULL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("noop não reescreve o gate-state", () => {
  const root = mkRoot("noop");
  try {
    classify(root, "LIGHT", "pi-feature");
    const statePath = statePathOf(root);
    // Marcador externo prova que o arquivo não foi reescrito.
    const marked = { ...readState(root), sentinel_untouched: true };
    fs.writeFileSync(statePath, JSON.stringify(marked));
    const before = fs.readFileSync(statePath, "utf8");

    const payload = payloadOf(classify(root, "LIGHT", "pi-feature"));

    assert.equal(payload.action, "noop");
    assert.equal(payload.mode, "LIGHT");
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transição fresh remove as 4 chaves de binding do estado anterior", () => {
  const root = mkRoot("fresh");
  try {
    const statePath = statePathOf(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        session_id: SESSION,
        brainstormed_binding: "old",
        adversary_fired_binding: "old",
        ceremony_generation: 3,
        ceremony_evidence: { any: "thing" },
        unrelated_fact: "preserve-me",
      }),
    );

    const payload = payloadOf(classify(root, "FULL", "pi-feature"));
    assert.equal(payload.action, "fresh");

    const state = readState(root);
    for (const key of [
      "brainstormed_binding",
      "adversary_fired_binding",
      "ceremony_generation",
      "ceremony_evidence",
    ]) {
      assert.equal(key in state, false, `${key} deveria ter sido removida`);
    }
    // Leg load-bearing da lane OC (classify-persist.test.mjs): a remoção é CIRÚRGICA,
    // não um reset do estado — chave alheia sobrevive à transição fresh.
    assert.equal(state.unrelated_fact, "preserve-me");
    assert.equal(state.mode, "FULL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sessão filha é negada com o texto EXATO da lane OC e não escreve estado", () => {
  const root = mkRoot("child");
  try {
    const payload = payloadOf(classify(root, "FULL", "pi-feature", { isChild: true }));

    assert.equal(
      payload.error,
      "classify denied on child session — only the top-level build session may classify; hands/eyes execute their brief only",
    );
    assert.equal(
      payload.hint,
      "only top-level build may classify; hands/eyes execute their brief only",
    );
    assert.equal(
      payload.received,
      JSON.stringify({ agent: "", parentSessionId: "<child>", sessionID: SESSION }),
    );
    assert.equal(fs.existsSync(path.join(root, ".pi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("piClassifyChildDenyReason é derivado da autoridade compartilhada (texto idêntico ao OC)", () => {
  const auth = decideClassifyAuthority({ agent: "", parentSessionId: "<child>", sessionId: "s1" });
  assert.equal(auth.ok, false);
  assert.equal(piClassifyChildDenyReason(), auth.reason);
  assert.equal(
    piClassifyChildDenyReason(),
    "classify denied on child session — only the top-level build session may classify; hands/eyes execute their brief only",
  );
});

test("sessionId inseguro é rejeitado antes de tocar disco", () => {
  const root = mkRoot("badsession");
  try {
    const payload = payloadOf(classify(root, "FULL", "pi-feature", { sessionId: "../escape" }));
    assert.deepEqual(payload, {
      error: "invalid sessionID",
      hint: "sessionID must pass isSafeSessionId",
      received: "../escape",
    });
    assert.equal(fs.existsSync(path.join(root, ".pi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mode ou feature_id inválidos são negados sem escrever estado", () => {
  const root = mkRoot("badargs");
  try {
    assert.equal(payloadOf(classify(root, "TURBO", "pi-feature")).error, "invalid mode");
    assert.equal(payloadOf(classify(root, "FULL", "Bad_Feature")).error, "invalid featureId");
    assert.equal(payloadOf(classify(root, "FULL", "../escape")).error, "invalid featureId");
    assert.equal(fs.existsSync(path.join(root, ".pi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projectRoot inválido devolve erro de gate-state path", () => {
  const payload = payloadOf(
    executePiClassify({ mode: "FULL", feature_id: "pi-feature" }, { projectRoot: "", sessionId: SESSION }),
  );
  assert.equal(payload.error, "invalid gate-state path");
  assert.equal(payload.received, SESSION);
});

test("falha de persistência devolve 'persistence failed' e não cria plano", () => {
  const root = mkRoot("persistfail");
  try {
    const payload = payloadOf(
      classify(root, "FULL", "pi-feature", {
        deps: {
          persistClassifyState: () => ({ ok: false, reason: "gate-state-write-failed" }),
        },
      }),
    );

    assert.equal(payload.error, "persistence failed");
    assert.equal(payload.hint, "gate-state-write-failed");
    assert.equal(payload.received, `${root}/.pi/harness/plans/pi-feature/execution-plan.json`);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gate-state ilegível: leitura é fail-open, persistência é fail-closed (igual à lane OC)", () => {
  const root = mkRoot("corrupt");
  try {
    const statePath = statePathOf(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ not json");

    // A leitura para decidir a transição ignora o lixo (trataria como fresh)...
    const payload = payloadOf(classify(root, "QUICK", "pi-feature"));
    // ...mas o merge sob lock recusa sobrescrever estado ilegível — mesma cadeia da lane OC.
    assert.equal(payload.error, "persistence failed");
    assert.equal(payload.hint, "gate-state persistence failed: gate-state-unreadable");
    assert.equal(fs.readFileSync(statePath, "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("piClassifyErrorResult mantém o formato {error,hint,received} da lane OC", () => {
  const result = piClassifyErrorResult("boom", "fix it", "raw");
  assert.deepEqual(result.details, { error: "boom", hint: "fix it", received: "raw" });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("emite o evento pipeline-type na transição real, igual à lane OC", () => {
  const root = mkRoot("obs");
  try {
    const events = [];
    const deps = { obsAppend: (ev) => events.push(ev) };

    classify(root, "QUICK", "pi-feature", { deps });
    assert.deepEqual(events, [{ type: "pipeline-type", mode: "QUICK" }]);

    // Escalada é transição real → emite o novo modo.
    classify(root, "FULL", "pi-feature", { deps });
    assert.deepEqual(events[1], { type: "pipeline-type", mode: "FULL" });

    // Replay no mesmo modo é noop → NÃO emite (mesma regra da lane OC).
    classify(root, "FULL", "pi-feature", { deps });
    assert.equal(events.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emissão de obs é fail-open — obsAppend que lança não quebra classify", () => {
  const root = mkRoot("obsfail");
  try {
    const payload = payloadOf(
      classify(root, "LIGHT", "pi-feature", {
        deps: {
          obsAppend: () => {
            throw new Error("outbox indisponível");
          },
        },
      }),
    );
    assert.equal(payload.action, "fresh");
    assert.equal(readState(root).mode, "LIGHT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no-ceremony emite pipeline-type NO-CEREMONY (normalização do OC)", () => {
  const root = mkRoot("obsnc");
  try {
    const events = [];
    classify(root, "no-ceremony", "chat-only", { deps: { obsAppend: (ev) => events.push(ev) } });
    assert.deepEqual(events, [{ type: "pipeline-type", mode: "NO-CEREMONY" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
