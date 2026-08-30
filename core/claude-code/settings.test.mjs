import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const settingsPath = resolve("core/claude-code/settings.json");
const SECRET_PATTERN = /(token|secret|password|api[_-]?key|bearer)/i;
const MAX_FLAG_VALUE_LENGTH = 40;

test("core/claude-code/settings.json is valid JSON", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);
  ok(settings, "settings parsed successfully");
});

test("hooks.PreToolUse has Agent matcher with entry-gate.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PreToolUse, "hooks.PreToolUse exists");
  ok(Array.isArray(settings.hooks.PreToolUse), "PreToolUse is an array");

  const agentHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentHook, "PreToolUse Agent matcher found");
  ok(
    agentHook.hooks &&
      agentHook.hooks[0] &&
      agentHook.hooks[0].command &&
      agentHook.hooks[0].command.includes("entry-gate.mjs"),
    "Agent hook command contains entry-gate.mjs"
  );
  ok(
    agentHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("hooks.PostToolUse has Bash matcher with stamp-triage.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PostToolUse, "hooks.PostToolUse exists");
  ok(Array.isArray(settings.hooks.PostToolUse), "PostToolUse is an array");

  const bashHook = settings.hooks.PostToolUse.find(
    (h) => h.matcher === "Bash"
  );
  ok(bashHook, "PostToolUse Bash matcher found");
  ok(
    bashHook.hooks &&
      bashHook.hooks[0] &&
      bashHook.hooks[0].command &&
      bashHook.hooks[0].command.includes("stamp-triage.mjs"),
    "Bash hook command contains stamp-triage.mjs"
  );
  ok(
    bashHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("hooks.SessionStart has compact and startup matchers with reinject-state.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.SessionStart, "hooks.SessionStart exists");
  ok(Array.isArray(settings.hooks.SessionStart), "SessionStart is an array");

  const compactHook = settings.hooks.SessionStart.find(
    (h) => h.matcher === "compact"
  );
  ok(compactHook, "SessionStart compact matcher found");
  ok(
    compactHook.hooks &&
      compactHook.hooks[0] &&
      compactHook.hooks[0].command &&
      compactHook.hooks[0].command.includes("reinject-state.mjs"),
    "compact hook command contains reinject-state.mjs"
  );
  ok(
    compactHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );

  const startupHook = settings.hooks.SessionStart.find(
    (h) => h.matcher === "startup"
  );
  ok(startupHook, "SessionStart startup matcher found");
  ok(
    startupHook.hooks &&
      startupHook.hooks[0] &&
      startupHook.hooks[0].command &&
      startupHook.hooks[0].command.includes("reinject-state.mjs"),
    "startup hook command contains reinject-state.mjs"
  );
  ok(
    startupHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("SessionStart startup wires version-check.mjs but compact does NOT (no re-nag mid-delivery)", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  const startupHook = settings.hooks.SessionStart.find((h) => h.matcher === "startup");
  ok(startupHook, "SessionStart startup matcher found");
  ok(
    startupHook.hooks.some((h) => h.command && h.command.includes("version-check.mjs")),
    "startup matcher wires version-check.mjs"
  );
  ok(
    startupHook.hooks.some((h) => h.command && h.command.includes("reinject-state.mjs")),
    "startup matcher still wires reinject-state.mjs alongside version-check"
  );

  const compactHook = settings.hooks.SessionStart.find((h) => h.matcher === "compact");
  ok(compactHook, "SessionStart compact matcher found");
  ok(
    !compactHook.hooks.some((h) => h.command && h.command.includes("version-check.mjs")),
    "compact matcher must NOT wire version-check.mjs (no re-nag mid-delivery)"
  );
});

test("NO Skill matcher in PreToolUse and exactly 9 hooks total", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PreToolUse, "PreToolUse exists");

  const skillMatcher = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Skill"
  );
  strictEqual(skillMatcher, undefined, "Skill matcher should not exist");

  let totalHooks = 0;
  if (settings.hooks.PreToolUse) {
    totalHooks += settings.hooks.PreToolUse.length;
  }
  if (settings.hooks.PostToolUse) {
    totalHooks += settings.hooks.PostToolUse.length;
  }
  if (settings.hooks.SessionStart) {
    totalHooks += settings.hooks.SessionStart.length;
  }

  strictEqual(totalHooks, 9, "exactly 9 hooks should be wired (Agent + Bash + ScheduleWakeup + Write|Edit for PreToolUse, Bash + Agent + Write for PostToolUse, compact + startup for SessionStart)");
});

// #ac-1.3 — settings.json wires a ScheduleWakeup PreToolUse matcher → entry-gate.mjs, so the
// ScheduleWakeup death rail actually fires (a tool with no wired matcher is never gated).
test("hooks.PreToolUse has ScheduleWakeup matcher with entry-gate.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  const wakeupHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "ScheduleWakeup"
  );
  ok(wakeupHook, "PreToolUse ScheduleWakeup matcher found");
  ok(
    wakeupHook.hooks &&
      wakeupHook.hooks[0] &&
      wakeupHook.hooks[0].command &&
      wakeupHook.hooks[0].command.includes("entry-gate.mjs"),
    "ScheduleWakeup hook command contains entry-gate.mjs"
  );
  ok(
    wakeupHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );

  // The pre-existing Agent + Bash entry-gate matchers remain intact alongside it.
  const matchers = settings.hooks.PreToolUse.map((h) => h.matcher);
  ok(matchers.includes("Agent"), "Agent matcher still present");
  ok(matchers.includes("Bash"), "Bash matcher still present");
});

test("hooks.PreToolUse has Bash matcher with entry-gate.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  const bashHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Bash"
  );
  ok(bashHook, "PreToolUse Bash matcher found");
  ok(
    bashHook.hooks &&
      bashHook.hooks[0] &&
      bashHook.hooks[0].command &&
      bashHook.hooks[0].command.includes("entry-gate.mjs"),
    "Bash hook command contains entry-gate.mjs"
  );
  ok(
    bashHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("Given the baseline settings.json, When parsed, Then hooks.PostToolUse contains an entry with matcher 'Agent' whose command invokes codex-eye-nudge.mjs", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PostToolUse, "hooks.PostToolUse exists");
  ok(Array.isArray(settings.hooks.PostToolUse), "PostToolUse is an array");

  const agentHook = settings.hooks.PostToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentHook, "PostToolUse Agent matcher found");
  ok(
    agentHook.hooks &&
      agentHook.hooks[0] &&
      agentHook.hooks[0].command &&
      agentHook.hooks[0].command.includes("codex-eye-nudge.mjs"),
    "Agent hook command contains codex-eye-nudge.mjs"
  );
  ok(
    agentHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("Given the baseline settings.json, When parsed, Then the existing PreToolUse 'Agent' entry still invokes entry-gate.mjs (the nudge did not replace or break the gate)", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PreToolUse, "hooks.PreToolUse exists");
  ok(Array.isArray(settings.hooks.PreToolUse), "PreToolUse is an array");

  const agentHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentHook, "PreToolUse Agent matcher found");
  ok(
    agentHook.hooks &&
      agentHook.hooks[0] &&
      agentHook.hooks[0].command &&
      agentHook.hooks[0].command.includes("entry-gate.mjs"),
    "PreToolUse Agent hook command contains entry-gate.mjs"
  );
  ok(
    agentHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("permissions baseline preserved and unchanged", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.permissions, "permissions object exists");
  ok(Array.isArray(settings.permissions.allow), "permissions.allow is array");
  ok(Array.isArray(settings.permissions.deny), "permissions.deny is array");

  ok(settings.permissions.allow.length > 0, "allow list is not empty");
  ok(settings.permissions.deny.length > 0, "deny list is not empty");

  ok(
    settings.permissions.allow.includes("Edit"),
    "Edit permission preserved"
  );
  ok(
    settings.permissions.allow.includes("Write"),
    "Write permission preserved"
  );
  ok(
    settings.permissions.deny.includes("Bash(git reset --hard:*)"),
    "deny list preserved"
  );

  ok(
    settings.autoMemoryDirectory === ".claude/memory",
    "autoMemoryDirectory preserved"
  );
});

/**
 * @description [orca-cutover] The production-deploy denies were pinned only in
 * `core/vps/cron-a-dispatch-seed.test.mjs`, which died with the retired VPS engine. Rehomed here
 * before that delete so removing dead engine code could not silently unpin a live invariant.
 *
 * The attack this closes is indirection, not a typed command: `Bash(npm run:*)` is an ALLOW, so a
 * project whose `package.json` carries `"deploy": "wrangler deploy"` had an APPROVED path to
 * production that never passed through a PR — the agent never types a denied command. Deny beats
 * allow in Claude Code, so both the direct wrangler verbs and the `npm run deploy` spelling are
 * denied. `d1 execute --local` must stay reachable: only `--remote` mutates production.
 *
 * This is string-match defense-in-depth, NOT a sandbox — an arbitrarily-named script
 * (`npm run ship`) still reaches wrangler, and no pattern list can enumerate a project's script
 * names. The real closure is credential scoping (`core/orca/README.md`).
 */
test("[orca-cutover] permissions.deny closes the production-deploy path, including the npm-run indirection", () => {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const deny = settings.permissions.deny;

  for (const rule of [
    "Bash(wrangler deploy*)",
    "Bash(wrangler versions*)",
    "Bash(wrangler secret*)",
    "Bash(wrangler r2*)",
    "Bash(wrangler d1 execute --remote*)",
    "Bash(wrangler d1 execute * --remote*)",
    "Bash(npm run deploy*)",
    "Bash(pnpm run deploy*)",
    "Bash(yarn deploy*)",
    "Bash(bun run deploy*)",
  ]) {
    ok(deny.includes(rule), `permissions.deny must carry ${rule}`);
  }

  // The 6 destructive-git denies are a separate, older class — they must survive untouched.
  const gitDenies = deny.filter((p) => p.startsWith("Bash(git "));
  ok(gitDenies.length === 6, `expected exactly 6 destructive-git denies, got ${gitDenies.length}`);

  // No deny may swallow local d1 work or routine npm scripts.
  ok(!deny.includes("Bash(wrangler d1 execute*)"), "a blanket d1-execute deny would block local dev");
  ok(!deny.some((p) => p === "Bash(npm run:*)" || p === "Bash(npm run*)"), "routine npm scripts must stay allowed");
});

/**
 * @description Given core/settings.json, When parsed as JSON, Then it is valid JSON AND
 * settings.env is an object containing keys HARNESS_CODEX_ADVERSARY and
 * HARNESS_REVIEW_ENABLED, each with a string value (the env block was previously empty {}).
 */
test("settings.env contains HARNESS_CODEX_ADVERSARY and HARNESS_REVIEW_ENABLED as strings", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  strictEqual(typeof settings.env, "object", "settings.env is an object");
  ok(settings.env, "settings.env is not null");
  ok(
    Object.prototype.hasOwnProperty.call(settings.env, "HARNESS_CODEX_ADVERSARY"),
    "settings.env is missing HARNESS_CODEX_ADVERSARY"
  );
  ok(
    Object.prototype.hasOwnProperty.call(settings.env, "HARNESS_REVIEW_ENABLED"),
    "settings.env is missing HARNESS_REVIEW_ENABLED"
  );
  strictEqual(
    typeof settings.env.HARNESS_CODEX_ADVERSARY,
    "string",
    "HARNESS_CODEX_ADVERSARY must be a string"
  );
  strictEqual(
    typeof settings.env.HARNESS_REVIEW_ENABLED,
    "string",
    "HARNESS_REVIEW_ENABLED must be a string"
  );
});

/**
 * @description Given the settings.env block, When inspected, Then it contains no secret
 * values — no key or value matching a token/key/password pattern. Flags are short strings
 * (e.g. "1"/"true"/"on"), not long secrets that would imply a leaked credential.
 */
test("settings.env has no secret-shaped keys or values", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.env, "settings.env exists");

  for (const [key, value] of Object.entries(settings.env)) {
    ok(
      !SECRET_PATTERN.test(key),
      `settings.env key "${key}" looks like a secret name`
    );
    strictEqual(typeof value, "string", `settings.env["${key}"] value is a string`);
    ok(
      !SECRET_PATTERN.test(value),
      `settings.env["${key}"] value looks like a secret`
    );
    ok(
      value.length < MAX_FLAG_VALUE_LENGTH,
      `settings.env["${key}"] value is too long to be a flag (possible secret leak)`
    );
  }
});

/**
 * @description Given the wired core/settings.json, When the PostToolUse[Agent] hooks array is
 * read, Then it contains BOTH codex-eye-nudge.mjs AND obs-eye-append.mjs (coexisting, neither
 * replacing the other), and the PreToolUse[Agent] array still contains entry-gate.mjs.
 */
test("hooks.PostToolUse Agent matcher wires BOTH codex-eye-nudge.mjs and obs-eye-append.mjs (coexisting), and PreToolUse Agent still wires entry-gate.mjs", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PostToolUse, "hooks.PostToolUse exists");
  ok(Array.isArray(settings.hooks.PostToolUse), "PostToolUse is an array");

  const agentPostHook = settings.hooks.PostToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentPostHook, "PostToolUse Agent matcher found");
  ok(Array.isArray(agentPostHook.hooks), "PostToolUse Agent matcher has a hooks array");

  ok(
    agentPostHook.hooks.some(
      (h) => h.command && h.command.includes("codex-eye-nudge.mjs")
    ),
    "PostToolUse Agent hooks still include codex-eye-nudge.mjs (not replaced)"
  );
  ok(
    agentPostHook.hooks.some(
      (h) => h.command && h.command.includes("obs-eye-append.mjs")
    ),
    "PostToolUse Agent hooks include obs-eye-append.mjs (coexisting alongside codex-eye-nudge.mjs)"
  );
  ok(
    agentPostHook.hooks.every(
      (h) => h.command && h.command.includes("${CLAUDE_PROJECT_DIR}")
    ),
    "every PostToolUse Agent hook command uses ${CLAUDE_PROJECT_DIR} variable"
  );

  ok(settings.hooks.PreToolUse, "hooks.PreToolUse exists");
  ok(Array.isArray(settings.hooks.PreToolUse), "PreToolUse is an array");

  const agentPreHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentPreHook, "PreToolUse Agent matcher found");
  ok(
    agentPreHook.hooks &&
      agentPreHook.hooks[0] &&
      agentPreHook.hooks[0].command &&
      agentPreHook.hooks[0].command.includes("entry-gate.mjs"),
    "PreToolUse Agent entry-gate.mjs preserved — the nudge/append hooks never touched the entry-gate"
  );
});

/**
 * @description Given the wired core/settings.json, When the PostToolUse[Agent] hooks array is
 * read, Then it contains a command that wires agent-idle-nudge.mjs (as a command, alongside
 * the existing codex-eye-nudge.mjs and obs-eye-append.mjs entries), using the
 * ${CLAUDE_PROJECT_DIR} variable like every other wired hook.
 */
test("hooks.PostToolUse Agent matcher wires agent-idle-nudge.mjs as a command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PostToolUse, "hooks.PostToolUse exists");
  ok(Array.isArray(settings.hooks.PostToolUse), "PostToolUse is an array");

  const agentHook = settings.hooks.PostToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentHook, "PostToolUse Agent matcher found");
  ok(Array.isArray(agentHook.hooks), "PostToolUse Agent matcher has a hooks array");

  ok(
    agentHook.hooks.some(
      (h) => h.command && h.command.includes("agent-idle-nudge.mjs")
    ),
    "PostToolUse Agent hooks include agent-idle-nudge.mjs"
  );
  ok(
    agentHook.hooks.some(
      (h) =>
        h.command &&
        h.command.includes("agent-idle-nudge.mjs") &&
        h.command.includes("${CLAUDE_PROJECT_DIR}")
    ),
    "agent-idle-nudge.mjs command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

// --- #807: rehomed from core/vps/cron-a-dispatch-seed.test.mjs:257 ------------------------------
// The seed test died with the retired `core/vps/` engine. This test is NOT redundant with the
// membership assertions above: those check that a deny STRING is present and that there are exactly
// 6 destructive-git denies. Tightening `Bash(git push --force *)` to `Bash(git push --force*)` keeps
// the count at 6, keeps every `.includes()` green, and silently denies `git push --force-with-lease`
// — which this harness's own shipping flow depends on. Only a RESOLVER test catches that, and before
// #807 this file was the only place one existed (`grep -n "force" settings.test.mjs` → nothing).

const CLAUDE_SETTINGS = JSON.parse(readFileSync(settingsPath, "utf8"));

/**
 * @description Minimal matcher for Claude Code's `Bash(...)` dialect, implementing only what's
 * needed to test our 2 narrowed deny patterns: per the official docs (code.claude.com/docs/en/permissions,
 * "Bash" section), a space immediately before a trailing `*` — or the equivalent `:*` suffix —
 * enforces a WORD BOUNDARY: the prefix must be followed by a space or end-of-string. `Bash(cmd *)`
 * matches `cmd foo` and bare `cmd`, but NOT `cmd-foo` (no boundary). A bare trailing `*` (no space)
 * has no such boundary. Deny always wins over allow in Claude Code regardless of pattern
 * specificity or file order ("Rules are evaluated in order: deny, then ask, then allow. The first
 * match in that order determines the outcome, and rule specificity doesn't change the order.") —
 * so the ONLY way to let force-with-lease through is to narrow the deny pattern itself, not reorder it.
 * @param {string} claudePattern
 * @param {string} command
 * @returns {boolean}
 */
function claudeBashMatches(claudePattern, command) {
  const inner = claudePattern.replace(/^Bash\(/, "").replace(/\)$/, "");
  // Reduce the `:*` idiom to its documented-equivalent literal " *" so one regex pass handles
  // both spellings; a trailing " *" (space before the star) enforces the word-boundary rule
  // (prefix followed by a space OR end-of-string) — a bare trailing "*" or an embedded "*" (e.g.
  // "git push * --force") is an ordinary unbounded wildcard, handled by the blanket replace below.
  const normalized = inner.endsWith(":*") ? `${inner.slice(0, -2)} *` : inner;
  const boundary = normalized.endsWith(" *");
  const body = boundary ? normalized.slice(0, -2) : normalized;
  const escapedBody = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const suffix = boundary ? "(?: .*)?" : "";
  return new RegExp(`^${escapedBody}${suffix}$`).test(command);
}

/**
 * @description Resolves a command against settings.json's Bash rules using Claude Code's real
 * precedence: deny always wins over allow, unconditionally (see `claudeBashMatches` doc).
 * @param {object} settings
 * @param {string} command
 * @returns {"deny"|"allow"|"ask"}
 */
function resolveClaudeBash(settings, command) {
  const denies = settings.permissions.deny.filter((p) => p.startsWith("Bash("));
  if (denies.some((p) => claudeBashMatches(p, command))) return "deny";
  const allows = settings.permissions.allow.filter((p) => p.startsWith("Bash("));
  if (allows.some((p) => claudeBashMatches(p, command))) return "allow";
  return "ask";
}

test("settings.json: git push --force-with-lease resolves allow (deny narrowed with a word-boundary space); raw --force/-f stay denied; exactly 6 destructive-git denies (#ac-2.1/#ac-2.2)", () => {
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push --force-with-lease origin minha-branch"), "allow");
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin --force-with-lease"), "allow");
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push --force origin main"), "deny");
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin --force"), "deny");
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push -f origin main"), "deny");
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin -f"), "deny");
  const bashDenies = CLAUDE_SETTINGS.permissions.deny.filter((p) => p.startsWith("Bash("));
  const gitDenyCount = bashDenies.filter((p) => p.startsWith("Bash(git ")).length;
  strictEqual(gitDenyCount, 6, "settings.json permissions.deny must still carry exactly 6 destructive-git Bash denies");

  // [orca-cutover] Production-deploy class. `Bash(npm run:*)` is an ALLOW, so a package.json with
  // `"deploy": "wrangler deploy"` was an approved path to production that never passed through a PR.
  // Deny beats allow in Claude Code, so these close both the direct wrangler spellings that mutate
  // production and the `npm run deploy` indirection. `d1 execute --local` must stay allowed.
  for (const command of [
    "wrangler deploy",
    "wrangler versions upload",
    "wrangler secret put API_KEY",
    "wrangler r2 object delete bucket/key",
    "wrangler d1 execute DB --remote --command \"delete from users\"",
    "npx wrangler deploy",
    "npm run deploy",
    "pnpm run deploy",
    "bun run deploy",
  ]) {
    strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, command), "deny", `settings.json must deny ${JSON.stringify(command)}`);
  }
  ok(
    resolveClaudeBash(CLAUDE_SETTINGS, "wrangler d1 execute DB --local --command \"select 1\"") !== "deny",
    "local d1 work must stay reachable — only --remote mutates production",
  );
  strictEqual(resolveClaudeBash(CLAUDE_SETTINGS, "npm run test"), "allow", "routine npm scripts must stay allowed");
});
