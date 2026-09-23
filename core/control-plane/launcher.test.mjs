import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildControlPlaneInvocation, HELP_TEXT, runControlPlane } from "./bin/harness-control-plane.mjs";

function home() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "control-launcher-")), "home"); }
const runtime = { ok: true, paths: { piCli: "/verified/pi-cli.js" } };

test("general agent launcher has a private cwd, one control extension and native Pi tools", () => {
  const controlHome = home();
  const invocation = buildControlPlaneInvocation(["--model", "openai-codex/gpt-test", "--thinking", "high"], { home: controlHome, runtime, env: {} });
  assert.equal(invocation.home, fs.realpathSync(controlHome));
  assert.equal(invocation.args.includes("--no-builtin-tools"), false);
  assert.ok(invocation.args.includes("--no-context-files"));
  assert.ok(invocation.args.includes("--no-extensions"));
  const extensions = invocation.args.flatMap((value, index) => value === "--extension" ? [invocation.args[index + 1]] : []);
  assert.deepEqual(extensions, [path.resolve("core/control-plane/extensions/control-plane-tools.ts")]);
  const systemPrompt = invocation.args[invocation.args.indexOf("--system-prompt") + 1];
  assert.match(systemPrompt, /Seu nome operacional é Clóvis/);
  assert.match(systemPrompt, /não\s+representa, simula ou fala em nome da pessoa real retratada nas transcrições/s);
  assert.doesNotMatch(systemPrompt, /Você é Clóvis de Barros Filho/);
  assert.match(systemPrompt, /não transforme uma resposta operacional\s+em aula longa/s);
  assert.match(systemPrompt, /ferramentas nativas do Pi/);
  assert.match(systemPrompt, /leitura, busca, shell,\s+edição e escrita/s);
  assert.match(systemPrompt, /atualize o Harness no projeto X/);
  assert.match(systemPrompt, /“atualize o Pi”, sem projeto ou qualificador/);
  assert.match(systemPrompt, /runtime Pi canônico e pinado do `claude-harness`/);
  assert.match(systemPrompt, /Não pergunte qual\s+projeto/s);
  assert.match(systemPrompt, /somente “atualize o Pi global”, “da máquina” ou “do Orca”/);
  assert.match(systemPrompt, /confirme a versão numa sessão nova/);
  assert.match(systemPrompt, /action=automation_status/);
  assert.match(systemPrompt, /primeiro caractere útil é `#` está inativa/);
  assert.equal(invocation.env.HARNESS_CONTROL_HOME, fs.realpathSync(controlHome));
  const again = buildControlPlaneInvocation([], { home: controlHome, runtime, env: {} });
  assert.equal(again.args[again.args.indexOf("--session-id") + 1], invocation.args[invocation.args.indexOf("--session-id") + 1]);
});

test("general agent launcher refuses flags that could add tools or extensions", () => {
  for (const args of [["--extension", "/tmp/evil.ts"], ["--tools", "bash"], ["--system-prompt", "override"]]) {
    assert.throws(() => buildControlPlaneInvocation(args, { home: home(), runtime, env: {} }), /unsupported control-plane launcher argument/);
  }
});

test("general agent launcher help is read-only and documents its private state", async () => {
  const lines = [];
  const code = await runControlPlane(["--help"], {
    print(value) { lines.push(value); },
    spawnSync() { throw new Error("help must not spawn Pi"); },
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, [HELP_TEXT.trimEnd()]);
  assert.match(lines[0], /HARNESS_CONTROL_HOME/);
  assert.match(lines[0], /operar a VPS/);
});

test("general agent launcher serializes the durable chat session", async () => {
  const calls = [];
  const code = await runControlPlane([], {
    home: home(), runtime, env: {},
    spawnSync(command, args, options) { calls.push({ command, args, options }); return { status: 0 }; },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, calls[0].options.env.HARNESS_CONTROL_HOME);
});

test("a capability profile change rotates conversation identity without deleting history", () => {
  const controlHome = home();
  fs.mkdirSync(controlHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(controlHome, "sessions"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(controlHome, "sessions", "legacy.jsonl"), "preserve me\n");
  fs.writeFileSync(path.join(controlHome, "agent-session.json"), JSON.stringify({
    schema: "harness.control.agent-session.v1",
    session_id: "legacy-session",
    created_at: "2026-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  const invocation = buildControlPlaneInvocation([], { home: controlHome, runtime, env: {} });
  const current = JSON.parse(fs.readFileSync(path.join(controlHome, "agent-session.json"), "utf8"));
  assert.equal(current.profile_revision, 10);
  assert.equal(current.supersedes_session_id, "legacy-session");
  assert.notEqual(current.session_id, "legacy-session");
  assert.equal(invocation.args[invocation.args.indexOf("--session-id") + 1], current.session_id);
  assert.equal(fs.readFileSync(path.join(controlHome, "sessions", "legacy.jsonl"), "utf8"), "preserve me\n");
});
