/**
 * @description Locked tests for the shared DANGEROUS_BASH_DENYLIST resolver (issue #516) — the
 * canonical source consumed by both `core/vps/cron-a-dispatch.mjs` (config seeding) and
 * `core/opencode/plugin/entry-gate.ts` (the plugin-level choke-point).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DANGEROUS_BASH_DENYLIST,
  matchesBashPattern,
  resolveDangerousBashCommand,
  decideDangerousBashDenylist,
  splitShellSegments,
} from "./dangerous-bash-denylist.mjs";

test("matchesBashPattern: '*' matches any sequence including empty, anchored at both ends", () => {
  assert.equal(matchesBashPattern("npx *", "npx vitest"), true);
  assert.equal(matchesBashPattern("npx *", "npx"), false); // requires at least the trailing space+content
  assert.equal(matchesBashPattern("git push --force*", "git push --force origin main"), true);
  assert.equal(matchesBashPattern("git push --force*", "git push --force-with-lease origin main"), true);
  assert.equal(matchesBashPattern("git push --force*", "echo git push --force"), false); // anchored, not substring
});

test("resolveDangerousBashCommand: destructive git patterns resolve deny", () => {
  for (const command of [
    "git push --force origin main",
    "git push origin --force",
    "git push -f origin main",
    "git push origin -f",
    "git reset --hard HEAD~1",
    "git clean -fd",
  ]) {
    assert.equal(resolveDangerousBashCommand(command), "deny", command);
  }
});

test("resolveDangerousBashCommand: git push --force-with-lease resolves allow (findLast carve-out over the broader --force deny)", () => {
  assert.equal(resolveDangerousBashCommand("git push --force-with-lease origin branch"), "allow");
  assert.equal(resolveDangerousBashCommand("git push origin --force-with-lease"), "allow");
});

test("resolveDangerousBashCommand: #499 hardening denies bash -c/node -e/npx/tar/source siblings", () => {
  for (const command of [
    "bash -c 'echo hi'",
    "sh -c 'echo hi'",
    "zsh -c 'echo hi'",
    "/usr/bin/bash -c 'echo hi'",
    "env bash -c 'echo hi'",
    "node -e 'console.log(1)'",
    "node --eval 'console.log(1)'",
    "python -c 'print(1)'",
    "python3.11 -c 'print(1)'",
    "python -m pip install x",
    "npx evil-package",
    "npm exec evil",
    "npm x evil",
    "pnpm dlx evil",
    "yarn dlx evil",
    "bun x evil",
    "bunx evil",
    "tar -xzf archive.tar.gz",
    "tar xf archive.tar",
    "unzip archive.zip",
    "source .venv/bin/activate",
    ". .venv/bin/activate",
  ]) {
    assert.equal(resolveDangerousBashCommand(command), "deny", command);
  }
});

test("resolveDangerousBashCommand: the harness's own prescribed npx invocations stay allowed", () => {
  for (const command of [
    "npx tsc --noEmit",
    "npx github:orobsonn/claude-harness#v1.2.3 init",
    "npx -y github:orobsonn/claude-harness#v1.2.3 init",
    'npx -y "github:orobsonn/claude-harness#v1.2.3" init',
    "npx @orobsonn/claude-harness init",
    "npx @orobsonn/claude-harness setup-local",
    "npx vitest run foo.test.mjs",
    "npx jest",
    "npx mocha",
    "npx --no-install vitest run",
    "npx -y vitest",
    "npx --yes vitest",
  ]) {
    assert.equal(resolveDangerousBashCommand(command), "allow", command);
  }
});

test("resolveDangerousBashCommand: an ordinary, unmatched command defaults to allow (targeted denylist, not a default-deny sandbox)", () => {
  assert.equal(resolveDangerousBashCommand("git status"), "allow");
  assert.equal(resolveDangerousBashCommand("ls -la"), "allow");
  assert.equal(resolveDangerousBashCommand("grep -r foo src/"), "allow");
});

test("resolveDangerousBashCommand: fails open on missing/non-string command", () => {
  assert.equal(resolveDangerousBashCommand(""), "allow");
  assert.equal(resolveDangerousBashCommand(undefined), "allow");
  assert.equal(resolveDangerousBashCommand(null), "allow");
});

test("decideDangerousBashDenylist: mirrors resolveDangerousBashCommand but returns a reasoned decision object", () => {
  const denied = decideDangerousBashDenylist("git reset --hard HEAD~1");
  assert.equal(denied.allow, false);
  assert.equal(denied.matchedPattern, "git reset --hard*");
  assert.match(denied.reason, /fleet-hardened deny pattern/);

  const allowed = decideDangerousBashDenylist("git push --force-with-lease origin branch");
  assert.equal(allowed.allow, true);
  assert.equal(allowed.matchedPattern, "git push --force-with-lease*");

  const unmatched = decideDangerousBashDenylist("git status");
  assert.deepEqual(unmatched, { allow: true });

  assert.deepEqual(decideDangerousBashDenylist(""), { allow: true });
  assert.deepEqual(decideDangerousBashDenylist(undefined), { allow: true });
});

test("DANGEROUS_BASH_DENYLIST is frozen (cannot be mutated at the call site)", () => {
  assert.throws(() => {
    DANGEROUS_BASH_DENYLIST["git push --force*"] = "allow";
  }, /Cannot assign to read only property|not extensible/);
});

// --- #516 adversarial review round: whole-string-anchored matching bypass via chained commands ---

test("splitShellSegments: splits on unquoted ; && || | ( ) and newline, keeps quoted metacharacters intact", () => {
  assert.deepEqual(splitShellSegments("echo a; echo b"), ["echo a", "echo b"]);
  assert.deepEqual(splitShellSegments("echo a && echo b"), ["echo a", "echo b"]);
  assert.deepEqual(splitShellSegments("echo a || echo b"), ["echo a", "echo b"]);
  assert.deepEqual(splitShellSegments("echo a | echo b"), ["echo a", "echo b"]);
  assert.deepEqual(splitShellSegments("echo a\necho b"), ["echo a", "echo b"]);
  assert.deepEqual(splitShellSegments("(echo a)"), ["echo a"]);
  assert.deepEqual(splitShellSegments('git commit -m "fix: a; b && c"'), ['git commit -m "fix: a; b && c"']);
  assert.deepEqual(splitShellSegments("echo 'a; b'"), ["echo 'a; b'"]);
  assert.deepEqual(splitShellSegments("git status"), ["git status"]);
  assert.deepEqual(splitShellSegments(""), []);
  assert.deepEqual(splitShellSegments("   "), []);
  assert.deepEqual(splitShellSegments(123), []);
});

test("decideDangerousBashDenylist: a leading harmless command no longer hides a denied command in the same bash call (issue #516 adversarial review)", () => {
  for (const command of [
    "true; git push --force origin main",
    " git push --force origin main", // leading whitespace
    "cd /tmp && git push --force origin main",
    "git push --force origin main\necho ok",
    "(git push --force origin main)",
    "git push --force-with-lease x; git push --force origin main",
    "echo hi | git push --force origin main",
  ]) {
    const decision = decideDangerousBashDenylist(command);
    assert.equal(decision.allow, false, command);
    assert.equal(decision.matchedPattern, "git push --force*", command);
  }
});

test("decideDangerousBashDenylist: a carve-out allow does not launder a SECOND, denied command chained after it", () => {
  const decision = decideDangerousBashDenylist("npx vitest run && npx evil-package");
  assert.equal(decision.allow, false);
  assert.equal(decision.matchedPattern, "npx *");
  assert.equal(decision.segment, "npx evil-package");
});

test("decideDangerousBashDenylist: a genuinely safe multi-segment command still resolves allow", () => {
  const decision = decideDangerousBashDenylist("cd /tmp && git status && echo done");
  assert.equal(decision.allow, true);
});

test("decideDangerousBashDenylist: single-segment allow/deny decisions keep their matchedPattern (unchanged shape for the common case)", () => {
  const denied = decideDangerousBashDenylist("git reset --hard HEAD~1");
  assert.equal(denied.allow, false);
  assert.equal(denied.matchedPattern, "git reset --hard*");

  const allowed = decideDangerousBashDenylist("git push --force-with-lease origin branch");
  assert.equal(allowed.allow, true);
  assert.equal(allowed.matchedPattern, "git push --force-with-lease*");
});
