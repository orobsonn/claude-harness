/**
 * @description Canonical, FROZEN in-code source of truth for the dangerous-bash-command deny-list
 * force-enforced onto every seeded worktree `opencode.json`, independent of whether the vendored
 * `opencode.json.example` exists or is reachable at seed time. Before this hardening, a project
 * vendored BEFORE this change with a stale root `opencode.json` missing these keys still hung
 * headless `opencode run --auto` on `permission=ask` (issue #282 recurrence) — the fix must not
 * depend on the example file being present, so this list is the double-fault safety net. Mirrors
 * `core/opencode/opencode.json.example`'s `permission.bash` deny entries; kept in sync manually
 * since — on a double-fault (malformed source AND unreadable/absent example) — this constant, not
 * the example file, is the ONLY source of the deny-list actually written to disk.
 *
 * [security] This is defense-in-depth against obvious foot-guns via a STRING-MATCH pattern list —
 * it is NOT a sandbox. It cannot contain a genuinely adversarial or prompt-injected agent (a
 * differently-worded or obfuscated command bypasses a string match trivially). Real containment of
 * an adversarial agent requires OS-level isolation — an unprivileged/dedicated account, no ambient
 * credentials, and controlled egress — which this list does not implement and is not a substitute for.
 * Concretely (verified against the installed `opencode` binary's `Wildcard.match`): the command is
 * normalized with `replaceAll("\\","/")` before matching, so a leading `\` (e.g. `\npx evil`, which
 * a shell treats identically to `npx evil`) fails EVERY pattern in this list — including the 6
 * pre-existing git denies — and falls through to `"*": "allow"`. No pattern rewrite closes this; it
 * is a property of the matcher itself, present before and independent of this hardening.
 * **`resolveDangerousBashCommand` below does NOT close this bypass either** (verified empirically
 * during the #516 post-merge review, 2026-07-27): `matchesBashPattern` is a plain `^pattern$` regex
 * anchor against the literal command string with no backslash normalization of its own, so
 * `\npx evil` fails every pattern here the same way it fails the native OC matcher and resolves
 * `allow` at BOTH layers. This remains an open, accepted risk in the same class as the leading-`\`
 * gap #499 already documented — string-match defense-in-depth, not a sandbox; closing it would
 * require normalizing the segment the same way the native matcher does before calling
 * `matchesBashPattern`, tracked as follow-up rather than blocking #516 (whose actual scope was the
 * agent-permission-override bypass, which IS closed — see `[security, CLOSED by #516]` below).
 *
 * [#486 oc-fleet-seed-migration] The 6 destructive-git denies mirror Claude Code exactly
 * (`core/claude-code/settings.json` `permissions.deny`) — parity decision recorded in
 * `docs/OC-CC-PARITY-ROADMAP-INPUT.md` item 6 (`denylist_final: os 6 denies de git destrutivo do
 * CC`). The broader OpenCode-only class this repo removed in #475 (rm -rf, sudo, chmod 777,
 * pipe-to-shell, netcat, dd, fork-bomb, git add ./-A/--all, git commit --no-verify) stays OUT:
 * Claude Code never denied it either, and reviving it would re-break the routine harness commands
 * #475 fixed. MUST stay disjoint from `RETIRED_OC_PERMISSION_ENTRIES`
 * (`./opencode-config-migration.mjs`) — a key can never be simultaneously frozen-forced here and
 * marked droppable by the migration ledger (cron-a-dispatch-seed.test.mjs asserts the disjunction).
 *
 * [#499 vps-fleet-bash-denylist-hardening] #475's adversarial review (PR #497) flagged that the
 * fleet VPS runs headless, WITHOUT container isolation, with real host credentials (`~/.ssh/**`
 * denied at the read layer only makes sense if a real key lives there) — and that #475 removed the
 * only fail-closed layer that covered `bash -c`, `node -e`/`python -c`, `npx`/`bunx`, `tar`
 * extraction, and `source`. This is a DELIBERATE, NARROW exception to CC parity, scoped to this
 * one fleet-seeding function (and, since #516, the fleet-dispatch plugin choke-point below) — it is
 * not part of the OC↔CC parity roadmap (that roadmap's own denylist_final decision, above, stays as
 * documented). The new deny keys below close each of these 5 command shapes AND the sibling
 * spellings a normal (non-obfuscated) agent would reach for — `sh -c`/`zsh -c`/`env bash -c`/a
 * path-qualified `.../bash -c`, `node --eval`/`node -p`/`node --print`, `python3.<minor> -c`,
 * `python* -m` (module execution, e.g. `python -m pip install`), `npm exec`/`npm x`/`pnpm dlx`/
 * `yarn dlx`/`bun x` (the non-`npx` package-runner idioms), `tar --extract`/old-style `tar xf` (no
 * leading `-`), `unzip`, and the `.` POSIX alias for `source` — an adversarial-review round on the
 * first cut of this hardening (#499 PR review) found 21 of 32 such sibling spellings still resolved
 * `allow`; these entries close them. The allow keys after them carve out the harness's own
 * prescribed `npx` invocations that the fleet already runs in production today (#ac-1.2): the
 * typecheck gate (`npx tsc --noEmit`), the self-installer in BOTH its documented forms — the
 * GitHub-ref form, PINNED to the `#v*` tagged-ref shape that `core/opencode/opencode.json.example`
 * (the forward-looking canonical template) vendors, in its 3 `-y`/quoting spellings (`npx [-y]
 * ["]github:orobsonn/claude-harness#v*["] init*`) — and the published npm-scoped package form
 * (`npx @orobsonn/claude-harness init/setup-local/setup-vps`, `README.md:259/267/292`). Deliberately
 * NOT carved out: the UNPINNED `#*` (no `v`) GitHub-ref spelling this repo's own root
 * `opencode.json` still carries — those 3 exact strings are already in
 * `RETIRED_OC_PERMISSION_ENTRIES` (superseded by the pinned form in v0.45.1, disjointness asserted
 * by test), so re-adding them here as a forced allow would directly contradict that migration
 * decision; a project still seeding the unpinned form should run `updating-harness` (which drops
 * it), not receive a permanent carve-out for a form the harness already retired. And the
 * locked-test runner invocation (`npx [--no-install|-y|--yes] vitest|jest|mocha …`) that
 * `core/shared/lib/validate-plan.mjs`'s `isAllowlistedLockedTestCommand` accepts and that
 * `core/opencode/agents/executor-{low,medium,high}.md` and `build.md` instruct the executor to run
 * against the frozen test snapshot — missing this one would BLOCK every headless test-gate run on
 * the fleet, the exact regression #ac-1.2 exists to catch. Every carve-out is anchored at the START
 * of the command (`npx <exact-runner-or-subcommand><wildcard-suffix>`), NOT a substring-anywhere
 * `npx *<name>*` — an earlier draft used substring matching and it was exploitable: `npx
 * evil-package vitest` or `npx some-pkg && cat ~/.ssh/id_rsa # jest` also contain the runner name
 * and would have resolved allow, silently defeating the new `"npx *"` deny for an attacker who
 * simply appends a trailing token; the installer carve-out had the SAME bug in its first draft
 * (`npx *orobsonn/claude-harness#*init*` — a leading `*` before the org name let `npx -y evilpkg
 * orobsonn/claude-harness# init` through, executing `evilpkg`). All are NEW key strings (not the
 * exact strings already declared in `opencode.json`/`opencode.json.example`), which matters because
 * of the ordering rule below.
 * Deliberately NOT covered (accepted, documented tradeoff of a denylist that must stay narrow): a
 * consumer project's OWN pre-existing `npx <tool>` allow for anything outside this prescribed set
 * (e.g. `npx playwright test`, `npx cypress run`) — `DANGEROUS_BASH_DENYLIST` is the LAST-merged,
 * most-authoritative source (see the ordering note below), so only entries added HERE can survive
 * the new `"npx *"` deny; a project cannot locally re-open it. Widening these carve-outs to cover
 * every third-party `npx` tool would recreate the unrestricted `"npx *": "allow"` this issue exists
 * to close — if a specific consumer tool needs an exception, add it here explicitly, reviewed case
 * by case, never widen the pattern itself.
 *
 * [#473] `git push --force-with-lease*` (and, by the same mechanism, the #499 `npx` carve-outs)
 * are deliberately ALLOW entries placed LAST (after every deny they would otherwise collide with).
 * OpenCode's own permission engine resolves a pattern list with `Array.prototype.findLast`
 * (confirmed by inspecting the installed `opencode` binary's `Permission.evaluate`:
 * `K.flat().findLast((z) => match(...) && match(...))`) — the LAST matching entry wins, not the
 * first or the most specific. `resolveDangerousBashCommand` below replicates this exact ordering
 * rule (last match in the object wins) so the plugin-level choke-point and the seeded config agree.
 * Placing an allow before the broader deny it narrows (as a naive "more specific rule should win"
 * instinct would suggest) would have the broader deny win instead. This ordering is load-bearing —
 * do not move these allow entries earlier in this object.
 *
 * [security, CLOSED by #516] This constant used to reach ONLY `config.permission.bash` (the GLOBAL
 * ruleset). OpenCode's own agent-permission merge appends an agent's own declared `permission`
 * (e.g. a `permission: bash: allow` YAML frontmatter entry) AFTER the global ruleset this constant
 * feeds; since resolution is `findLast` (last match wins), an agent that declared its own
 * `bash: allow` made EVERY deny in this constant unreachable FOR THAT AGENT — and the fleet
 * dispatched with exactly such an agent (`opencode run --agent build`,
 * `core/vps/cron-a-dispatch.mjs`'s own `--agent build` invocation). Issue #516 closed this two
 * ways: (1) the redundant `bash: allow` was removed from every agent frontmatter that carried it
 * (`core/opencode/agents/*.md`, locked against drift by `eyes-permission-lockdown.test.mjs`), and
 * (2) `resolveDangerousBashCommand`/`decideDangerousBashDenylist` below back that removal with a
 * choke-point in `core/opencode/plugin/entry-gate.ts` that re-checks the raw command directly
 * against this same constant, independent of whatever `config.permission.bash` the OC config merge
 * resolves to — so a future agent authored with `bash: allow` again is still caught at the plugin
 * layer, even before the anti-drift test catches it in CI.
 */
export const DANGEROUS_BASH_DENYLIST = Object.freeze({
  "git push --force*": "deny",
  "git push * --force*": "deny",
  "git push -f*": "deny",
  "git push * -f*": "deny",
  "git reset --hard*": "deny",
  "git clean -f*": "deny",
  "git push --force-with-lease*": "allow",
  "git push * --force-with-lease*": "allow",
  "bash -c*": "deny",
  "sh -c*": "deny",
  "zsh -c*": "deny",
  "*/bash -c*": "deny",
  "env bash -c*": "deny",
  "node -e*": "deny",
  "node --eval*": "deny",
  "node -p*": "deny",
  "node --print*": "deny",
  "python -c*": "deny",
  "python3 -c*": "deny",
  "python3.* -c*": "deny",
  "python* -m*": "deny",
  "npx *": "deny",
  "npm exec*": "deny",
  "npm x *": "deny",
  "pnpm dlx*": "deny",
  "yarn dlx*": "deny",
  "bun x*": "deny",
  "bunx *": "deny",
  "tar -x*": "deny",
  "tar --extract*": "deny",
  "tar x*": "deny",
  "unzip *": "deny",
  "source *": "deny",
  ". *": "deny",
  "npx tsc --noEmit*": "allow",
  "npx github:orobsonn/claude-harness#v* init*": "allow",
  "npx -y github:orobsonn/claude-harness#v* init*": "allow",
  'npx -y "github:orobsonn/claude-harness#v*" init*': "allow",
  "npx @orobsonn/claude-harness init*": "allow",
  "npx @orobsonn/claude-harness setup-*": "allow",
  "npx vitest*": "allow",
  "npx jest*": "allow",
  "npx mocha*": "allow",
  "npx --no-install vitest*": "allow",
  "npx --no-install jest*": "allow",
  "npx --no-install mocha*": "allow",
  "npx -y vitest*": "allow",
  "npx -y jest*": "allow",
  "npx -y mocha*": "allow",
  "npx --yes vitest*": "allow",
  "npx --yes jest*": "allow",
  "npx --yes mocha*": "allow",
});

/**
 * @description Whether a single `permission.bash`-style glob `pattern` (`*` = any sequence,
 * including empty; every other character literal) matches `command`, anchored at both ends.
 * @param {string} pattern
 * @param {string} command
 * @returns {boolean}
 */
export function matchesBashPattern(pattern, command) {
  if (typeof pattern !== "string" || typeof command !== "string") return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(command);
}

/**
 * @description Splits a shell command string into individual command segments at unquoted `;`, `\n`,
 * `&&`, `||`, `|`, `(`, and `)` — the shell metacharacters that let one bash tool call carry MULTIPLE
 * commands the OpenCode engine itself evaluates as separate nodes (verified against the installed
 * `opencode` binary: `descendantsOfType("command")` walks each command node of the parsed shell tree
 * independently, and `ShellTool.collect` adds one pattern per node). Quote-aware (single AND double,
 * with backslash-escape support) so a semicolon or `&&` INSIDE a quoted argument — e.g.
 * `git commit -m "fix: a; b"` — is correctly kept in one segment, not split. Not a full shell
 * parser (does not resolve `$(...)`/backtick command substitution, heredocs, or `<()`/`>()` process
 * substitution into their own segments) — a best-effort structural split sufficient to close the
 * whole-string-anchored-regex bypass this function existed to prevent (issue #516 adversarial
 * review): a single command like `true; git push --force origin main` previously matched NO pattern
 * (every pattern is anchored `^...$` against the FULL string) and resolved allow.
 * @param {string} command
 * @returns {string[]} Trimmed, non-empty segments.
 */
export function splitShellSegments(command) {
  if (typeof command !== "string") return [];
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < command.length && command[i + 1] === quote) {
        current += command[i + 1];
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * @description Resolves a SINGLE command segment (already split by `splitShellSegments`) against
 * `DANGEROUS_BASH_DENYLIST` using the SAME last-match-wins (`findLast`) semantics as the real
 * OpenCode `permission.bash` engine. Iterates entries in REVERSE declaration order and returns the
 * first (i.e. last-declared) match; this is what lets `"git push --force-with-lease*": "allow"`
 * (declared after `"git push --force*": "deny"`) correctly override the broader deny, and lets the
 * `npx <prescribed-runner>*` carve-outs override the broad `"npx *": "deny"`.
 * @param {string} segment
 * @returns {{ allow: boolean, reason?: string, matchedPattern?: string }}
 */
function resolveSegment(segment) {
  const entries = Object.entries(DANGEROUS_BASH_DENYLIST);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, action] = entries[i];
    if (matchesBashPattern(pattern, segment)) {
      if (action === "allow") return { allow: true, matchedPattern: pattern };
      return {
        allow: false,
        reason: `command matches the fleet-hardened deny pattern "${pattern}"`,
        matchedPattern: pattern,
      };
    }
  }
  return { allow: true };
}

/**
 * @description Resolves `command` against `DANGEROUS_BASH_DENYLIST`, independent of any resolved
 * `opencode.json` or agent-frontmatter permission map — the plugin-level choke-point invoked
 * directly from `tool.execute.before` in `core/opencode/plugin/entry-gate.ts` (issue #516). Splits
 * `command` into segments first (`splitShellSegments`) and denies if ANY segment resolves deny — a
 * chained command like `git push --force-with-lease x; git push --force origin main` is denied by
 * its second segment even though its first segment is an explicit carve-out, matching what the
 * native OC per-node evaluation would do. Fail-open on a missing or non-string command, or on a
 * command that splits into zero segments (e.g. empty/whitespace-only) — this backstop never bricks a
 * dispatch on its own infra failure; the resolved `permission.bash` config is still the primary
 * enforcement layer.
 * @param {string} command
 * @returns {{ allow: boolean, reason?: string, matchedPattern?: string, segment?: string }}
 */
export function decideDangerousBashDenylist(command) {
  if (typeof command !== "string" || command.length === 0) return { allow: true };
  const segments = splitShellSegments(command);
  if (segments.length === 0) return { allow: true };
  if (segments.length === 1) return resolveSegment(segments[0]);
  for (const segment of segments) {
    const decision = resolveSegment(segment);
    if (!decision.allow) return { ...decision, segment };
  }
  return { allow: true };
}

/**
 * @description Thin `"allow"|"deny"` wrapper around `decideDangerousBashDenylist` — mirrors the
 * shape of the local `resolveBash` test helper in `cron-a-dispatch-seed.test.mjs` for tests that
 * only need the resolved action, not the full reasoned decision object.
 * @param {string} command
 * @returns {"allow"|"deny"}
 */
export function resolveDangerousBashCommand(command) {
  return decideDangerousBashDenylist(command).allow ? "allow" : "deny";
}
