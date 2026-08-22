---
name: connecting-orca
description: "Takes a project that already has the harness vendored and wires it to Orca end-to-end until autonomous delivery actually runs: diagnoses whether THIS session can reach the VPS at all (the failures that read as 'no access' but are not), confirms the runtime + pairing, registers the repo, installs the implementation queue (project JSON + selector cron) and the PR-review/conditional-merge automation, then proves it with one canary issue. Use after initializing-projects/updating-harness, or whenever an agent session concludes it cannot operate the VPS."
---

# Connecting-Orca — from "harness vendored" to "autonomous delivery running"

The harness being installed in a repo does **not** mean anything is delivering. Two more layers have
to exist: an Orca runtime that dispatches, and a queue that tells it what to dispatch. This skill
installs those, in order, and does not finish until a real issue has moved through them.

**Orca dispatches; the repo's vendored `.claude/` executes.** Nothing here installs a second delivery
engine — the pipeline is already in the repo. See `core/orca/README.md` in the harness repo.

**Announce at start (pt-br):** "Ligando este projeto no Orca — vou do diagnóstico até uma issue canária entregue."

All identifiers and commands stay in English; every message to the operator is **pt-br, product-language**.

---

## Mode

**LOCAL/interactive.** Phases 1–5 pair runtimes, write config and change a crontab — an autonomous
session must not do that on its own. In a **HEADLESS** session, run **Phase 0 only** and report the
diagnosis; never mutate.

---

## Phase 0 — Can this session reach the VPS at all? (always first)

Three failures read as *"I have no access"* and are not. Stacked, they produce a confident wrong
conclusion, and an agent that reaches it stops and hands the work back to the operator — while another
session on the same machine, in the same minute, operates the VPS fine.

Run the deterministic diagnosis instead of concluding:

```bash
node .claude/skills/connecting-orca/references/orca-doctor.mjs [--ssh-host <alias>] [--environment <nome>]
```

**Both flags are optional, and on a first run you usually have neither** — the environment name is
produced by Phase 1, and the SSH alias by the playbook's `~/.ssh/config` block. Run it bare first: it
still reports whether the CLI answers, whether this machine drives a runtime, and what is paired.
(From a machine with no harness vendored: `npx @orobsonn/claude-harness orca-doctor`.)

It probes the Orca CLI, the runtime this machine drives, the paired environment and SSH, and prints,
for each blocked path, the barrier + its fix. Its table is the same one in
`docs/orca-headless-vps-playbook.md` §8 *"Operando a VPS a partir de uma sessão de agente"* — a docs
oracle pins them together, so what you read here cannot drift from what the operator reads there.

**A verdict may only claim what a probe returned.** A local CLI that answers is not a VPS you can
reach: without a proven `--environment` round-trip (or SSH), say so plainly instead of implying the
shortcut works. The first version of this tool got that wrong and produced exactly the kind of
confident wrong conclusion it exists to prevent.

**When the barrier is the sandbox,** the fix is to re-run *that same command* with the Bash sandbox
disabled. If your session cannot do that itself, it is an operator step — say which command needs it
and why, and do not treat it as missing access.

**The rule this phase exists for: never report "não tenho acesso à VPS".** Report the barrier and its
fix, or the raw output. "No access" is a conclusion the doctor is designed to make unnecessary.

Two things worth carrying in your head, both measured on a live VPS:

- **Probe with a real command, never a version flag.** `orca --version` exits 3, and the `orca` shim on
  `PATH` can answer `--help` with `bad option: --no-sandbox` while `/opt/orca/orca-linux.AppImage`
  answers everything correctly. A liveness check built on a flag reports "no CLI" on a machine whose
  CLI works.
- **Every `--json` answer is an envelope** — `{ id, ok, result, _meta }`, payload under `result`. `ok:false`
  is a *refusal* (the CLI ran and said no), not "Orca is down". Different symptom, different repair.

**The shortcut that dispenses with SSH:** everything that is Orca's own state answers over
`--environment <nome>` from the local CLI — `orca repo list`, `orca worktree list|ps`,
`orca automations list`, `orca worktree create`. What it cannot do is anything that is the *machine's*
state: writing `~/.config/claude-harness/projects/<slug>.json`, editing the `orca` user's crontab,
`systemctl`/`journalctl`, updating the AppImage. That needs SSH. Say this split out loud to the
operator when a path is blocked — it is usually the difference between "blocked" and "blocked for the
two commands that actually need it".

---

## Phase 1 — Runtime up, and this machine paired to it

**Everything in this phase that touches the machine runs ON the VPS.** From a laptop that means SSH,
and the alias is the one from the playbook's `~/.ssh/config` block:

```bash
ssh <alias> 'systemctl status orca-serve'
```

1. Service alive: `systemctl status orca-serve` → `active (running)`, and
   `journalctl -u orca-serve --no-pager | grep "Bound endpoint" | tail -1` on the configured port.
   Not installed yet? That is the VPS playbook, §1–§6 — install first, come back here.
2. Pair this machine, if `orca environment list --json` shows nothing:
   ```bash
   journalctl -u orca-serve --no-pager | grep "Pairing URL" | tail -1   # on the VPS
   orca environment add --name <nome> --pairing-code "<o code= da URL>"  # on this machine
   ```
   **Treat the pairing code as a password** — it is full control of the runtime. Each pairing mints a
   separate revocable token; never reuse one across devices.
3. Prove the round-trip, not just the network:
   ```bash
   orca status --environment <nome> --json    # result.runtime → reachable:true, state:"ready"
   ```
   `Unknown environment: <id>` here means the runtime restarted and the pairing did not survive:
   restart `orca-serve` and pair again. It does **not** mean you lack access.

---

## Phase 2 — The repo exists in Orca, and you have its id + clone path

```bash
orca repo list --environment <nome> --json
```

**It is `repo list`, not `repo ls`** — the build answers `ok:false` with
`{"error":{"code":"invalid_argument","message":"Unknown command: repo ls","data":{"suggestions":["repo list","repo add"]}}}`.
When a subcommand is refused, read `suggestions` from the error itself rather than guessing.

From the repo's row take two values, both required later:
- `id` → `orcaRepoId`;
- `path` → `clonePath`, the clone Orca creates worktrees from.

Repo not there yet? Register it (`orca repo add`, or the desktop) and list again.

---

## Phase 3 — The implementation queue (what gets dispatched, and when)

Two artifacts, and nothing else: **one config JSON per project** + **one cron line** running
`core/orca/select-and-dispatch.mjs`. On the VPS, as the user that owns the Orca runtime (**never root** —
the scoped credential only means something because the selector is that user's cron):

```bash
ssh -t <alias> 'cd <caminho-do-repo> && npx @orobsonn/claude-harness setup-orca'   # alias: setup-vps
```

**The `-t` is not optional.** The wizard is interactive (it reads answers from a TTY); a plain
`ssh host 'npx …'` gives it no terminal and it aborts on the first required field. Running directly on
the VPS, drop the `ssh -t` and just run the command.

The wizard writes `~/.config/claude-harness/projects/<slug>.json` and one fenced crontab block. Field
reference: `core/orca/README.md` in the harness repo. Three answers decide whether this works:

- **`clonePath` is not optional.** `--base-branch main` resolves the *local* ref of that clone, which
  fetches but never advances — every run is then born from a base that silently ages, and the symptom
  arrives hours later as a merge conflict in files the run never touched. The selector fetches and
  dispatches on `origin/<baseBranch>`; a wrong path re-arms exactly that bug.
- **`globalMaxWorking` is a property of the MACHINE, not of the project.** The selector counts `working`
  worktrees across the whole VPS, so every project's JSON carries the same number.
- **Start with `titleIncludes: "[canary]"`.** Without a filter the chosen issue is simply the oldest open
  `harness:ready` — in a real backlog, a task from years ago, not the one you want to watch first.

Then confirm the cron line the wizard wrote (`crontab -l`) starts with
`ORCA_BIN=/opt/orca/orca-linux.AppImage`. The AppImage is **not on `PATH`**, and the shim that
sometimes is, is broken — without the variable the tick dies before selecting anything, and every
failure in this layer looks identical from outside: nothing gets delivered, silently. The current
wizard writes it; a queue installed by an older one does not have it.

The labels the queue reads must exist in the repo (idempotent):

```bash
gh label create "harness:ready"       -c "#0E8A16" -d "Pronta para a pipeline autônoma" 2>/dev/null || true
gh label create "harness:in-progress" -c "#FBCA04" -d "Em execução"                     2>/dev/null || true
gh label create "harness:done"        -c "#5319E7" -d "PR aberto"                       2>/dev/null || true
```

---

## Phase 4 — The review + conditional-merge automation (the other half of the queue)

Dispatch alone gives you PRs that nobody merges. The reviewer is **a scheduled Orca automation, not
code in this repo** — its prompt is versioned in the harness repo at `core/orca/review-prompt.md`. That path is **not
vendored into a project** (`.claude/` carries agents/skills/rules/hooks, not `core/orca/`), so fetch it:

```bash
gh api repos/orobsonn/claude-harness/contents/core/orca/review-prompt.md \
  -H 'Accept: application/vnd.github.raw' > /tmp/review-prompt.md
```

Replace `<OWNER/REPO>` and `<BASE>`, then install it as the automation's prompt
(`orca automations list --environment <nome> --json` shows what already exists there).

It merges only when: its own verdict is *merge*, **no** ARMED high-severity finding, CI concluded
`SUCCESS`, no conflict — and the merge passes `--match-head-commit <sha>`.

Two things that are never re-derived correctly by hand:

- **The merge command cannot pass `-R`/`--repo` (nor `--auto`).** The harness `entry-gate.mjs` reads the
  PR's check rollup before allowing `gh pr merge` and refuses an ambiguous target. The automation runs
  inside the target repo's checkout and passes only the PR number. That is what keeps the CI gate
  inescapable.
- **STEP 3.5 is the step nobody invents on their own.** Parallel runs all append to the same annotation
  files (`.claude/memory/MEMORY.md`, `.claude/kaizen.md`, the touched folder's `CLAUDE.md`), so they
  conflict *always*; a conflicted PR makes GitHub skip the merge-commit checks, so CI never runs and the
  review refuses for lack of green CI — delivery stops on bookkeeping, not quality. The integrator
  reconciles: merge the base in the checkout, resolve by **union inside the allowlist only**, re-register
  the head SHA after pushing (the old one no longer matches), and abort to `harness:needs-human` for any
  conflict outside it. `merge=union` in `.gitattributes` does not fix this — GitHub does not honor it
  server-side.

---

## Phase 5 — Prove it with one canary (do not skip)

Nothing here is "connected" until an issue has moved. With `titleIncludes: "[canary]"` active:

1. Open a small, verifiable issue whose title carries `[canary]`, labelled `harness:ready`
   (`creating-issues` writes it in the right shape).
2. Watch one tick — `tail -f ~/.local/state/claude-harness/<slug>.log` — and expect either a dispatch or
   an explicit `skip:` reason. A tick that logs nothing at all is the failure mode to chase.
3. Confirm the worktree exists (`orca worktree ps --environment <nome> --json`), then the PR, then the
   review automation's verdict on it.

`STUCK: #N` in the log is the one state that needs a human: the worktree failed **and** returning the
label failed too. Hand the label back manually.

---

## Exit checklist (report this to the operator, in pt-br)

- [ ] `orca status --environment <nome> --json` → `reachable: true`, `state: ready`
- [ ] repo listed in Orca; `orcaRepoId` and `clonePath` recorded in the project JSON
- [ ] project JSON + fenced cron line installed (with `ORCA_BIN`), owned by the Orca user, not root
- [ ] `harness:ready` / `harness:in-progress` / `harness:done` labels exist in the repo
- [ ] review automation installed, carrying STEP 3.5 and the four merge criteria
- [ ] one `[canary]` issue dispatched, its PR opened, its review verdict observed
- [ ] the operator knows how to widen it: drop `titleIncludes` when the canary is boring

---

## Anti-patterns

- **Concluding "sem acesso à VPS".** Three ordinary barriers produce that reading with high confidence
  and none of them is missing access. Run the doctor; report the barrier and its fix.
- **Probing liveness with a version/help flag.** Measured: `--version` exits 3, and the PATH shim can
  fail `--help` while the AppImage works. Ask a real command with `--json`.
- **Reading a `--json` answer at the top level.** The payload is under `result`. A parser per command
  re-arms the same mine for the next integrator — unwrap once, at the boundary.
- **Installing the queue as root.** The selector is the Orca user's cron; running it as root is one of
  the measured reasons the previous engine was retired.
- **Stopping at Phase 3.** Dispatch without the review automation is a PR pile nobody merges — the
  queue has two halves.
- **Skipping the canary.** Every failure in this layer is silent from outside: no delivery, no error.
  The canary is what makes the silence readable.
- **Reviving a second dispatch engine** next to the selector. The repo's vendored `.claude/` is the
  pipeline; Orca only dispatches into it.
