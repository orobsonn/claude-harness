/** @description Submission contract tests: schema, exact form fields, repo/label policy, and argv isolation. */
import test from "node:test";
import assert from "node:assert/strict";
import { renderIssueBody, submitIssue, validateIssueDraft } from "./submit-issue.mjs";

function validDraft(overrides = {}) {
  return {
    title: "[harness] vendor-issue-authoring",
    summary: "Entrega autoria segura de issues.",
    user_journeys: ["#uj-1: o operador publica uma issue valida"],
    acceptance_criteria: ["#ac-1.1: a issue recebe todos os campos canonicos"],
    scope: "Pode: core/opencode. Nao tocar: scheduling.",
    sensitive: "não",
    priority: "P1",
    size: "S",
    dependencies: ["Nenhuma."],
    ...overrides,
  };
}

test("invalid drafts name missing fields and reject enum/title/tag violations", () => {
  assert.throws(() => validateIssueDraft({}), /title/);
  assert.throws(() => validateIssueDraft(validDraft({ title: "plain title" })), /title/);
  assert.throws(() => validateIssueDraft(validDraft({ user_journeys: ["usuario faz algo"] })), /user_journeys/);
  assert.throws(() => validateIssueDraft(validDraft({ acceptance_criteria: ["#ac-1: invalido"] })), /acceptance_criteria/);
  assert.throws(() => validateIssueDraft(validDraft({ sensitive: "talvez" })), /sensitive/);
  assert.throws(() => validateIssueDraft(validDraft({ priority: "P3" })), /priority/);
  assert.throws(() => validateIssueDraft(validDraft({ size: "XL" })), /size/);
});

test("rendered issue body contains every exact required field and harness-deps fence", () => {
  const body = renderIssueBody(validateIssueDraft(validDraft()));
  for (const required of [
    "### Resumo + por quê",
    "### User journeys",
    "#uj-1:",
    "### Critérios de aceite (testáveis e observáveis)",
    "#ac-1.1:",
    "### Escopo",
    "### Domínio sensível?",
    "### Prioridade",
    "### Tamanho estimado",
    "### Dependências",
    "```harness-deps",
  ]) {
    assert.ok(body.includes(required), `missing required body field: ${required}`);
  }
});

test("dependencies reject mixed sentinel and preserve multiple references in canonical block", () => {
  assert.throws(
    () => validateIssueDraft(validDraft({ dependencies: ["Nenhuma.", "#12"] })),
    /Nenhuma\. deve ser usada sozinha/,
  );
  const body = renderIssueBody(validateIssueDraft(validDraft({ dependencies: ["#12", "#34", "#56"] })));
  assert.match(body, /```harness-deps\n#12\n#34\n#56\n```/);
  assert.equal((body.match(/#12/g) ?? []).length, 1);
  assert.equal((body.match(/#34/g) ?? []).length, 1);
  assert.equal((body.match(/#56/g) ?? []).length, 1);
});

test("dependencies reject malformed and injection-bearing references", () => {
  for (const dependencies of [
    ["12"],
    ["#12; touch /tmp/pwned"],
    ["#12\n```\nmalicious"],
    ["#12", "$(id)"],
  ]) {
    assert.throws(() => validateIssueDraft(validDraft({ dependencies })), /dependencies/);
  }
});

test("submission uses fixed executable argv and sends hostile body text only through stdin", () => {
  const calls = [];
  const hostile = "$(touch /tmp/pwned); `id`; --repo attacker/repo";
  const run = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: options.input });
    if (file === "git") return "git@github.com:acme/project.git";
    if (args[0] === "repo") return "acme/project";
    if (args[0] === "label" && args[1] === "list") return JSON.stringify([{ name: "harness:ready" }]);
    if (args[0] === "issue") return "https://github.com/acme/project/issues/42";
    throw new Error(`unexpected call: ${file} ${JSON.stringify(args)}`);
  };

  const url = submitIssue(validDraft({ summary: hostile, scope: hostile }), { run });
  assert.equal(url, "https://github.com/acme/project/issues/42");
  const issue = calls.find((call) => call.args[0] === "issue");
  assert.equal(issue.file, "gh");
  assert.deepEqual(issue.args, [
    "issue", "create", "--repo", "acme/project", "--title", "[harness] vendor-issue-authoring",
    "--label", "harness:ready", "--body-file", "-",
  ]);
  assert.ok(issue.input.includes(hostile));
  assert.ok(!issue.args.some((arg) => arg.includes("touch /tmp/pwned")));
});

test("repo mismatch and absent label fail before issue creation; label creation is explicit", () => {
  const calls = [];
  const runMismatch = (file, args) => {
    calls.push([file, args]);
    return file === "git" ? "https://github.com/acme/project.git" : "other/project";
  };
  assert.throws(() => submitIssue(validDraft(), { run: runMismatch }), /difere do origin/);
  assert.equal(calls.some(([, args]) => args[0] === "issue"), false);

  const created = [];
  const run = (file, args) => {
    created.push([file, [...args]]);
    if (file === "git") return "https://github.com/acme/project.git";
    if (args[0] === "repo") return "acme/project";
    if (args[0] === "label" && args[1] === "list") return "[]";
    if (args[0] === "label" && args[1] === "create") return "";
    if (args[0] === "issue") return "url";
    throw new Error("unexpected");
  };
  assert.throws(() => submitIssue(validDraft(), { run }), /--create-label/);
  assert.equal(created.some(([, args]) => args[0] === "issue"), false);

  created.length = 0;
  assert.equal(submitIssue(validDraft(), { run, createLabel: true }), "url");
  assert.ok(created.some(([, args]) => args[0] === "label" && args[1] === "create"));
  assert.ok(created.some(([, args]) => args[0] === "issue"));
});
