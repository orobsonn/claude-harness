# Pi Harness Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o harness atual como pacote Pi que o Orca executa em uma worktree de issue.

**Architecture:** O pacote mantém roles e skills como dados e usa a extensão de subagents existente. Um launcher fino constrói uma invocação Pi fechada, carregando as extensões e skills vendored, e uma extensão Pi valida somente o contrato de dispatch do harness.

**Tech Stack:** Node.js 22.19+, Pi 0.84.4, `@gotgenes/pi-subagents` 21.2.0, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-01-pi-harness-port-design.md`

## Global Constraints

- Pi runtime: `@earendil-works/pi-coding-agent` exactly `0.84.4`.
- Only the ten namespaced `harness-*` roles are accepted by the dispatch rail.
- Eyes have no write/edit/bash tool; hands are executor, sniper and test-author.
- No background or nested dispatch in v1; one foreground subagent at a time.
- Pi runs inside the Orca-created worktree. Docker is not a v1 dependency.
- The launcher always passes `--no-extensions`, `--no-skills`, and `--no-context-files`, then explicitly loads this package’s resources.

---

### Task 1: Catalog and role assets

**Files:**
- Create: `core/pi/lib/roles.mjs`
- Create: `core/pi/lib/roles.test.mjs`
- Create: `core/pi/runtime/agents/harness-{planner,executor,compliance,adversary,sniper,security,harvester,plan-reviewer,shipper,test-author}.md`

**Interfaces:**
- Produces `CANONICAL_ROLES`, `HAND_ROLES`, `EYE_ROLES`, `isCanonicalRole(name)` and `rolePolicy(name)`.
- Each agent file has locked frontmatter and a system prompt copied semantically from `.Codex/agents/<role>.toml`.

- [ ] **Step 1: Write the failing test**

```js
import { isCanonicalRole, rolePolicy } from "./roles.mjs";
assert.equal(isCanonicalRole("harness-planner"), true);
assert.equal(isCanonicalRole("planner"), false);
assert.deepEqual(rolePolicy("harness-adversary").tools, ["read", "grep", "find", "ls"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/pi/lib/roles.test.mjs`
Expected: FAIL because `roles.mjs` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
export const CANONICAL_ROLES = Object.freeze(["harness-planner" /* remaining roles */]);
export function isCanonicalRole(name) { return CANONICAL_ROLES.includes(name); }
export function rolePolicy(name) { return POLICIES[name] ?? null; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/pi/lib/roles.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify agent assets**

Run: `node --test core/pi/lib/roles.test.mjs`
Expected: the test reads every role asset and confirms its locked tool allowlist matches `rolePolicy`.

### Task 2: Dispatch hook

**Files:**
- Create: `core/pi/extensions/harness-dispatch.ts`
- Create: `core/pi/lib/dispatch-rail.mjs`
- Create: `core/pi/lib/dispatch-rail.test.mjs`

**Interfaces:**
- Produces `validateSubagentDispatch(input, options)` returning `{ok:true}` or `{ok:false, reason:string}`.
- The extension applies that pure result to Pi’s `tool_call` hook for the `subagent` tool.

- [ ] **Step 1: Write the failing test**

```js
assert.equal(validateSubagentDispatch({ subagent_type: "planner" }).ok, false);
assert.equal(validateSubagentDispatch({ subagent_type: "harness-planner", run_in_background: true }).ok, false);
assert.equal(validateSubagentDispatch({ subagent_type: "harness-planner", max_turns: 16 }).ok, true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/pi/lib/dispatch-rail.test.mjs`
Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
export function validateSubagentDispatch(input, { shadowedRoles = new Set() } = {}) {
  if (!isCanonicalRole(input?.subagent_type)) return deny("unknown-role");
  if (shadowedRoles.has(input.subagent_type)) return deny("shadowed-role");
  if (input.run_in_background === true) return deny("background-disabled");
  if (Number(input.max_turns ?? 16) > 16) return deny("turn-limit");
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/pi/lib/dispatch-rail.test.mjs`
Expected: PASS for unknown, shadowed, background, and turn-limit cases.

- [ ] **Step 5: Verify hook loadability**

Run: `node --check core/pi/lib/dispatch-rail.mjs`
Expected: exit 0; Pi integration is verified in Task 4.

### Task 3: Package resources and launcher

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `core/pi/bin/pi-harness.mjs`
- Create: `core/pi/bin/pi-harness.test.mjs`
- Create: `core/pi/skills/` (copies of the current `harness-*` skills)
- Create: `core/pi/prompts/harness-runtime.md`
- Create: `core/pi/runtime/subagents.json`

**Interfaces:**
- Produces `buildPiHarnessInvocation({root, argv, env})` returning `{command,args,env}`.
- `bin.pi-harness` calls the Pi 0.84.4 binary with the returned values.
- Root `package.json` declares the Pi resources and exact production dependencies.

- [ ] **Step 1: Write the failing test**

```js
const invocation = buildPiHarnessInvocation({ root: "/pkg", argv: ["-p", "hello"], env: {} });
assert.deepEqual(invocation.args.slice(0, 3), ["--no-extensions", "--no-skills", "--no-context-files"]);
assert.match(invocation.env.PI_CODING_AGENT_DIR, /core\/pi\/runtime$/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/pi/bin/pi-harness.test.mjs`
Expected: FAIL because the launcher helper does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
export function buildPiHarnessInvocation({ root, argv, env }) {
  return { command: process.execPath, args: [PI_CLI, "--no-extensions", "--no-skills", "--no-context-files", /* explicit -e and --skill */, ...argv], env: { ...env, PI_CODING_AGENT_DIR: join(root, "core/pi/runtime") } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/pi/bin/pi-harness.test.mjs`
Expected: PASS, including explicit extension order and no inherited `PI_CODING_AGENT_DIR`.

- [ ] **Step 5: Install and smoke the package**

Run: `npm install --ignore-scripts && node core/pi/bin/pi-harness.mjs --help`
Expected: exit 0, showing Pi help without loading project-discovered resources.

### Task 4: Pi and Orca integration evidence

**Files:**
- Create: `core/pi/README.md`
- Create: `core/pi/integration.test.mjs`
- Create: `docs/pi-orca-live-run.md`

**Interfaces:**
- Pi print/JSON smoke invokes the wrapper and exposes `subagent` with the canonical roles.
- Guide gives the exact `orca terminal create` command for an existing issue worktree.

- [ ] **Step 1: Write the failing integration test**

```js
const result = spawnSync(process.execPath, ["core/pi/bin/pi-harness.mjs", "--help"], { encoding: "utf8" });
assert.equal(result.status, 0);
assert.match(result.stdout + result.stderr, /Pi/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/pi/integration.test.mjs`
Expected: FAIL before the launcher/dependencies are installed.

- [ ] **Step 3: Implement only the guide and smoke assertion**

```text
orca terminal create --worktree issue:<N> --title pi-harness --command "npx --no-install pi-harness --mode json -p '<issue prompt>'"
```

- [ ] **Step 4: Run focused and complete verification**

Run: `node --test "core/pi/**/*.test.mjs" && npm test`
Expected: all focused and repository tests pass.

- [ ] **Step 5: Run the live Oráculo validation**

Run: create or select a bounded `harness:ready` issue, open an Orca worktree, start `pi-harness` in JSON/print mode with the issue as prompt, and retain the transcript.
Expected: the transcript shows triage, plan, at least one bounded implementation/test action, an independent review, and final evidence. If the Pi provider is unavailable, report that external authentication as the blocker without claiming a live validation.
