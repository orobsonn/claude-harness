/**
 * @description Live-artifact contract for the shipped OpenCode configuration: the root
 * `opencode.json` this repo runs under and `core/opencode/opencode.json.example` that consumer
 * projects receive. Pins the plugin auto-load contract (#322) and the `permission.bash` /
 * `permission.question` resolution semantics (#473 oc-permission-bash-parity, #ac-1.1/#ac-1.2,
 * #ac-2.1/#ac-2.2/#ac-2.3).
 *
 * REHOMED by issue #807 from `core/vps/cron-a-dispatch-seed.test.mjs` (:63, :130, :146, :183, :190),
 * which died with the retired `core/vps/` engine. These five tests call NO engine entry point — they
 * read live shipped artifacts off `process.cwd()`, which is why they must survive the engine.
 *
 * The delete-safety audit proved they are the only coverage of their invariants:
 *   - this is the ONLY test in the repo that reads the LIVE root `opencode.json`
 *     (`bash-decide.test.mjs` pins `opencode.json.example` only, and only the `.state` denies;
 *     `vendor-core.test.mjs` pins `permission.question` on the example only);
 *   - `grep -rn "force-with-lease" --include="*.test.mjs" core/ scripts/ modules/` returned ten
 *     hits, ALL inside the retired seed file;
 *   - the key-ORDER assertion below has no equivalent anywhere. Because OpenCode resolves
 *     `permission.bash` with `findLast` (last-match-wins), reordering two keys silently re-denies
 *     `git push --force-with-lease` while every membership assertion in the repo stays green.
 *
 * The `CANONICAL_OC_PLUGINS.length` legs of the original :63 did not come with it: that const was an
 * export of the retired `cron-a-dispatch.mjs` and died with it. Its live subject — the canonical
 * plugin stubs being ON DISK, which is what makes an empty `plugin: []` mean "auto-load" rather than
 * "no plugins" — is asserted directly against the plugin directory instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { defaultOcPluginPaths } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";

/** @description The canonical plugin stubs OpenCode auto-globs out of `.opencode/plugin/`. */
const CANONICAL_STUBS = [
  "entry-gate.ts",
  "marker-authority.ts",
  "plan-gate.ts",
  "plan-write-gate.ts",
  "reinject-state.ts",
  "version-check.ts",
  "obs-plan-write.ts",
  "obs-eye.ts",
  "obs-hand.ts",
  "agent-idle-nudge.ts",
];

const readJson = (...segments) => JSON.parse(readFileSync(join(process.cwd(), ...segments), "utf8"));
const ocConfigs = () => ({
  root: readJson("opencode.json"),
  example: readJson("core", "opencode", "opencode.json.example"),
});

test("OpenCode plugin[] is empty for harness; CANONICAL files stay on disk (auto-load)", () => {
  const { root, example } = ocConfigs();
  // Config must not list harness autoload paths (OC globs .opencode/plugin/*).
  assert.deepEqual(root.plugin ?? [], []);
  assert.deepEqual(example.plugin ?? [], []);
  assert.deepEqual(defaultOcPluginPaths(), []);
  // An empty `plugin: []` only means "auto-load" while the stubs are actually on disk to be globbed.
  for (const stub of CANONICAL_STUBS) {
    assert.ok(
      existsSync(join(process.cwd(), "core", "opencode", "plugin", stub)),
      `core/opencode/plugin/${stub} must stay on disk — an empty plugin[] relies on the auto-glob finding it`,
    );
  }
  assert.ok(CANONICAL_STUBS.length >= 10);
});

test("OpenCode compacts a long autonomous build session before its model context becomes unreliable", () => {
  const { root, example } = ocConfigs();
  const expected = { auto: true, prune: false, preserve_recent_tokens: 8000, reserved: 60000 };
  assert.deepEqual(root.compaction, expected, "root OpenCode must compact early with a bounded recent tail");
  assert.deepEqual(example.compaction, expected, "vendored OpenCode must preserve the same compaction contract");
});

// --- #473 oc-permission-bash-parity ------------------------------------------------------

const CLAUDE_SETTINGS = JSON.parse(
  readFileSync(join(process.cwd(), "core", "claude-code", "settings.json"), "utf8"),
);

/**
 * @description Last-match-wins resolver over an OC `permission.bash` map, mirroring the REAL
 * OpenCode permission engine: `Permission.evaluate` resolves with `Array.prototype.findLast`
 * (confirmed by reading the installed `opencode` binary's minified source —
 * `K.flat().findLast((z) => match(...) && match(...))`) — the LAST entry in the object whose
 * pattern matches `command` wins, not the first and not the most specific. Iterates keys in
 * REVERSE insertion order (excluding the `"*"` fallback) and returns the first match found that
 * way, which is equivalent to `findLast` over the forward order.
 * @param {Record<string,string>} bashMap
 * @param {string} command
 * @returns {string}
 */
function resolveBash(bashMap, command) {
  const entries = Object.entries(bashMap).filter(([pattern]) => pattern !== "*");
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, action] = entries[i];
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(command)) return action;
  }
  return bashMap["*"];
}

/**
 * @description Builds a representative sample command for a `Bash(...)` allow pattern: the
 * `cmd:*` idiom gets a generic trailing arg (`cmd x`); a bare exact pattern (no `:*`) is used
 * verbatim. Lets the allowlist-parity test assert behavioral coverage without assuming the OC
 * glob key is byte-identical to the Claude Code pattern string (the two DSLs format prefix
 * matches differently, e.g. `Bash(gh:*)` vs OC's `"gh *"`).
 * @param {string} claudePattern
 * @returns {string}
 */
function claudeAllowToSample(claudePattern) {
  const inner = claudePattern.replace(/^Bash\(/, "").replace(/\)$/, "");
  return inner.endsWith(":*") ? `${inner.slice(0, -2)} x` : inner;
}

const CLAUDE_BASH_ALLOW_SAMPLES = CLAUDE_SETTINGS.permissions.allow
  .filter((p) => p.startsWith("Bash("))
  .map(claudeAllowToSample);

/** @description Real commands each of settings.json's 6 destructive-git Bash denies must block. */
const DESTRUCTIVE_GIT_SAMPLES = [
  "git reset --hard HEAD~1",
  "git push --force origin main",
  "git push origin --force",
  "git push -f origin main",
  "git push origin -f",
  "git clean -fd",
];

test("opencode.json + opencode.json.example: permission.bash contains the same broad allowlist as core/claude-code/settings.json (#ac-1.1)", () => {
  for (const [label, cfg] of Object.entries(ocConfigs())) {
    for (const sample of CLAUDE_BASH_ALLOW_SAMPLES) {
      assert.equal(
        resolveBash(cfg.permission.bash, sample),
        "allow",
        `${label} opencode.json permission.bash must allow ${JSON.stringify(sample)} (mirrors settings.json)`,
      );
    }
  }
});

test("opencode.json + opencode.json.example: Auto Mode allows routine Bash and denies destructive git, recursive deletion, and state mutation", () => {
  const claudeDenyCount = CLAUDE_SETTINGS.permissions.deny.filter((p) => p.startsWith("Bash(git ")).length;
  assert.equal(claudeDenyCount, 6, "settings.json must carry exactly 6 destructive-git Bash denies");
  for (const [label, cfg] of Object.entries(ocConfigs())) {
    const bash = cfg.permission.bash;
    assert.equal(bash["*"], "allow", `${label}: routine Bash must not prompt`);
    assert.equal(Object.values(bash).includes("ask"), false, `${label}: Auto Mode config must not contain ask`);
    for (const sample of DESTRUCTIVE_GIT_SAMPLES) {
      assert.equal(resolveBash(bash, sample), "deny", `${label}: ${JSON.stringify(sample)} must resolve deny`);
    }
    assert.equal(
      resolveBash(bash, "git push --force-with-lease origin br"),
      "allow",
      `${label}: git push --force-with-lease must NOT be swallowed by the 6 destructive-git denies`,
    );
    for (const command of [
      "rm -rf ./build",
      "rm -fr ./build",
      "rm -r -f ./build",
      "rm -R -f ./build",
      "rm --recursive --force ./build",
      `node -e 'require("fs").writeFileSync(".opencode/plans/.state/s/gate-state.json", "{}")'`,
      `python3 -c 'open(".opencode/plans/.state/s/gate-state.json", "w").write("{}")'`,
      "sed -i 's/x/y/' .opencode/plans/.state/s/gate-state.json",
      "tee .opencode/plans/.state/s/gate-state.json",
      "rm -f .opencode/plans/.state/s/gate-state.json",
    ]) assert.equal(resolveBash(bash, command), "deny", `${label}: ${JSON.stringify(command)} must resolve deny`);
    for (const command of ["pnpm lint", "docker compose ps", "node scripts/report.mjs"]) {
      assert.equal(resolveBash(bash, command), "allow", `${label}: routine ${JSON.stringify(command)} must resolve allow`);
    }
  }
});

test("opencode.json + opencode.json.example: permission.question resolves 'allow' locally (#ac-1.2)", () => {
  const { root, example } = ocConfigs();
  assert.equal(root.permission.question, "allow", "root opencode.json: permission.question must resolve 'allow' locally");
  assert.equal(example.permission.question, "allow", "opencode.json.example: permission.question must resolve 'allow' locally");
});

test("opencode.json + opencode.json.example: git push --force-with-lease resolves 'allow'; raw --force/-f stay 'deny' — the lease allow is ordered AFTER the broad deny so findLast (last-match-wins) picks it (#ac-2.1/#ac-2.2/#ac-2.3)", () => {
  for (const [label, cfg] of Object.entries(ocConfigs())) {
    const bash = cfg.permission.bash;
    assert.equal(resolveBash(bash, "git push --force-with-lease origin minha-branch"), "allow", `${label}: force-with-lease must resolve allow`);
    assert.equal(resolveBash(bash, "git push origin --force-with-lease"), "allow", `${label}: force-with-lease (remote-first form) must resolve allow`);
    assert.equal(resolveBash(bash, "git push --force origin main"), "deny", `${label}: raw --force must stay denied`);
    assert.equal(resolveBash(bash, "git push -f origin main"), "deny", `${label}: raw -f must stay denied`);
    assert.equal(resolveBash(bash, "git push origin --force"), "deny", `${label}: raw --force (remote-first form) must stay denied`);
    // #ac-2.3 invariant for THIS engine (findLast/last-match-wins, verified against the installed
    // opencode binary): the lease allow keys must be positioned AFTER (not before) the broader
    // --force/-f deny keys they would otherwise collide with — the opposite of a "most specific
    // rule wins" intuition. Locks the ORDER itself so a future edit can't silently un-invert it.
    const keys = Object.keys(bash);
    const leaseIdx = keys.indexOf("git push --force-with-lease*");
    const forceIdx = keys.indexOf("git push --force*");
    assert.ok(leaseIdx > -1 && forceIdx > -1, `${label}: both keys must exist`);
    assert.ok(leaseIdx > forceIdx, `${label}: git push --force-with-lease* must be ordered AFTER git push --force* (findLast picks the last match)`);
  }
});
