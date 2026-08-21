/**
 * @description Locked tests for the shared DANGEROUS_BASH_DENYLIST resolver (issue #516) — the
 * canonical source consumed by `core/opencode/plugin/entry-gate.ts` (the plugin-level choke-point).
 *
 * [orca-cutover] The FROZEN key list and the production-deploy class used to be pinned only in
 * `core/vps/cron-a-dispatch-seed.test.mjs`. That file died with the retired VPS engine, so those
 * assertions were rehomed HERE before the delete — otherwise removing a folder full of dead engine
 * code would have silently unpinned a live security invariant, which is exactly the failure shape
 * `kaizen.md` records twice (a check that validates the shape of a thing instead of the claim it
 * makes). The frozen list below is the reason a new deny or a new carve-out cannot slip in
 * unreviewed: widening it must update this test.
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
    "npx --yes --package=github:orobsonn/claude-harness#v1.2.3 claude-harness lifecycle-snapshot updating-harness",
    "npx --yes --package=github:orobsonn/claude-harness#v1.2.3 claude-harness lifecycle-update --target opencode --ref v1.2.3",
    "npx --yes --package=github:orobsonn/claude-harness#v1.2.3 claude-harness init --target opencode",
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

test("DANGEROUS_BASH_DENYLIST: the FULL deny-key list is FROZEN — order is load-bearing (findLast wins), so no extras, none missing, order preserved", () => {
  const denyKeys = Object.entries(DANGEROUS_BASH_DENYLIST)
    .filter(([, value]) => value === "deny")
    .map(([key]) => key);
  assert.deepEqual(
    denyKeys,
    [
      "git push --force*",
      "git push * --force*",
      "git push -f*",
      "git push * -f*",
      "git reset --hard*",
      "git clean -f*",
      "bash -c*",
      "sh -c*",
      "zsh -c*",
      "*/bash -c*",
      "env bash -c*",
      "node -e*",
      "node --eval*",
      "node -p*",
      "node --print*",
      "python -c*",
      "python3 -c*",
      "python3.* -c*",
      "python* -m*",
      "npx *",
      "npm exec*",
      "npm x *",
      "pnpm dlx*",
      "yarn dlx*",
      "bun x*",
      "bunx *",
      "tar -x*",
      "tar --extract*",
      "tar x*",
      "unzip *",
      "source *",
      ". *",
      "wrangler deploy*",
      "wrangler versions*",
      "wrangler secret*",
      "wrangler r2*",
      "wrangler d1 execute --remote*",
      "wrangler d1 execute * --remote*",
      "npx wrangler deploy*",
      "npx wrangler versions*",
      "npx wrangler secret*",
      "npx wrangler r2*",
      "npx wrangler d1 execute --remote*",
      "npx wrangler d1 execute * --remote*",
      "npm run deploy*",
      "pnpm run deploy*",
      "yarn deploy*",
      "bun run deploy*",
    ],
    `deny keys drifted from the pinned list, got ${JSON.stringify(denyKeys)}`,
  );
});

test("DANGEROUS_BASH_DENYLIST: the FULL allow-key list is pinned too — a widened carve-out must be reviewed here, not slipped in", () => {
  const allowKeys = Object.entries(DANGEROUS_BASH_DENYLIST)
    .filter(([, value]) => value === "allow")
    .map(([key]) => key);
  assert.deepEqual(
    allowKeys,
    [
      "git push --force-with-lease*",
      "git push * --force-with-lease*",
      "npx tsc --noEmit*",
      "npx --yes --package=github:orobsonn/claude-harness#v* claude-harness lifecycle-snapshot updating-harness",
      "npx --yes --package=github:orobsonn/claude-harness#v* claude-harness lifecycle-update --target * --ref v*",
      "npx --yes --package=github:orobsonn/claude-harness#v* claude-harness init*",
      "npx github:orobsonn/claude-harness#v* init*",
      "npx -y github:orobsonn/claude-harness#v* init*",
      'npx -y "github:orobsonn/claude-harness#v*" init*',
      "npx @orobsonn/claude-harness init*",
      "npx @orobsonn/claude-harness setup-*",
      "npx vitest*",
      "npx jest*",
      "npx mocha*",
      "npx --no-install vitest*",
      "npx --no-install jest*",
      "npx --no-install mocha*",
      "npx -y vitest*",
      "npx -y jest*",
      "npx -y mocha*",
      "npx --yes vitest*",
      "npx --yes jest*",
      "npx --yes mocha*",
    ],
    `allow keys drifted from the pinned list, got ${JSON.stringify(allowKeys)}`,
  );
});

test("resolveDangerousBashCommand: the production-deploy class is denied — including the `npm run deploy` indirection that an approved `Bash(npm run:*)` would otherwise wave through", () => {
  for (const command of [
    "wrangler deploy",
    "wrangler deploy --env production",
    "wrangler versions upload",
    "wrangler versions deploy",
    "wrangler secret put API_KEY",
    "wrangler secret delete API_KEY",
    "wrangler r2 object delete bucket/key",
    'wrangler d1 execute DB --remote --command "delete from users"',
    "wrangler d1 execute DB --remote",
    "npx wrangler deploy",
    "npm run deploy",
    "npm run deploy --workspace=api",
    "pnpm run deploy",
    "bun run deploy",
    "yarn deploy",
  ]) {
    assert.equal(
      resolveDangerousBashCommand(command),
      "deny",
      `production-mutating command must be denied: ${JSON.stringify(command)}`,
    );
  }
});

test("resolveDangerousBashCommand: local development against the same tools stays reachable — only the production-mutating verbs are denied", () => {
  for (const command of [
    'wrangler d1 execute DB --local --command "select 1"',
    "wrangler dev",
    "wrangler types",
    "npm run test",
    "npm run build",
    "npm run typecheck",
  ]) {
    assert.equal(
      resolveDangerousBashCommand(command),
      "allow",
      `local/dev command must stay allowed: ${JSON.stringify(command)}`,
    );
  }
});

test("decideDangerousBashDenylist: a production deploy chained after a harmless command is still denied (segment split, not whole-string match)", () => {
  const decision = decideDangerousBashDenylist("npm run build && npm run deploy");
  assert.equal(decision.allow, false);
  assert.equal(decision.segment, "npm run deploy");
});
