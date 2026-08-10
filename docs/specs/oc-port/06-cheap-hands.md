# 06 — Cheap hands (spawn + capture)

**Phase:** 1  
**Depends on:** 03 capture-oracle pure, 04 test-author/executor, ADR-001  
**Implements:** safe hand execution on OC (and keep CC path)  
**Out of scope:** VPS scheduling (09)

---

## 1. Philosophy

Strong eyes, cheap hands. Safety is **not** trusting the hand model. Safety is:

1. **Frozen locked test** before impl (test-author + compliance fidelity)  
2. **Independent capture** after hand (git diff vs freeze + re-run tests)  
3. **Scope/frozen path checks** (shared pure)  
4. **Reset worktree** on FAILED  
5. **On-disk run-record** as durable escalation evidence (not OS-level provenance)  

Probe proof: after plugin **denied** bash, model still emitted success text → **prose is not evidence**.

---

## 2. Default models (OC)

Hands use Grok ladder (02). **No Ollama** in default.  
CC target may keep Ollama spawn path separately.

---

## 3. Flow (both runtimes)

```
planner pins assertion
  → test-author writes test
  → compliance fidelity check
  → freeze commit sha + frozen paths manifest
  → spawn hand (subprocess) with brief; test read-only
  → capture oracle (shared checks + injected git/test)
  → outcome ∈ {DONE, FAILED, NOT_DONE, CONFIG_ERROR, CAPTURE_ERROR} (canonical enum in 03)
  → FAILED: reset to freeze; optional escalate per policy
  → CONFIG_ERROR / CAPTURE_ERROR: fail closed; never treat as DONE
```

---

## 4. Runtime adapters

### Claude (`core/claude-code` / existing refs)

- `spawn-hand.mjs` / `dispatch-hand.mjs` / `runLiveDispatch`  
- `claude -p` + model + allowedTools + output-format json  
- token via env (`OLLAMA_HAND_TOKEN` pattern) — never in plugin  

### OpenCode (new adapter)

**Path (canonical):** `core/opencode/hands/run-hand.mjs` (or `references/spawn-hand-opencode.mjs` under orchestrating-delivery OC skill).

```
opencode run --dir <project> --agent <hand-spawn-agent> --auto --format json \
  --title "hand:<feature>:<task>" \
  "<brief or prompt file contents>"
```

#### Probe P2 — critical

`opencode run --agent X` requires agent `mode: **primary**`.  
If X is `mode: subagent`, OC falls back to default primary and the hand prompt/model are wrong.

**Required pattern:** spawn-specific agents with `mode: primary` (e.g. `executor-high-spawn.md`) **or** document that hand files used by CLI are primary while in-session loop uses `task` + subagent twins. T7 DoD must name the chosen pattern.

Parse **NDJSON** events (`tool_use`, `text`, `step_finish`, `error`).  
**Do not** use process exit code as success (probe: 0 on deny; 1 on some API errors only).  
**Do not** trust assistant text after a denied tool (probe P12 hallucination).

Hand agent frontmatter:

- correct model tier from routing  
- `mode: primary` if used with `opencode run`  
- `tools.task: false`  
- tight permissions  
- no access to rewrite frozen tests (enforce via capture + optional plugin)

### Shared

- `checkScope`, `checkFrozen`, `evaluateRun`, run-record builder fields  
- redaction helpers for tokens in logs  

---

## 4b. Worktree policy by outcome (locked)

| Outcome | Worktree action (mandatory) | Next step |
|---|---|---|
| `DONE` | keep changes in scope | continue loop |
| `FAILED` | **reset to freeze** + delete hand-created untracked via pre/post snapshot set-difference (§ cleanup) | optional escalate / re-dispatch |
| `NOT_DONE` | **same as FAILED** — reset + hand-created untracked cleanup | do not leave partial writes for next role |
| `CAPTURE_ERROR` | **quarantine:** reset to freeze if any uncommitted hand writes detected; if reset impossible, mark gate-state `hand_quarantine: true` for that `featureId+taskId` | never DONE; **entry-gate / spawn adapter** deny any further hand spawn for that task while flag set until orchestrator clears via mark |
| `CONFIG_ERROR` | no hand writes expected; if tree dirty vs freeze, reset anyway | fix config before retry |

**Invariant:** after any non-`DONE` hand attempt, the next role must not see uncommitted partial hand output. Prose claiming success never skips this table.

### Untracked / partial write cleanup (self-contained — do not invent “CC policy”)

**Pre-spawn snapshot (mandatory):** before starting the hand, adapter records:
- `freezeCommitSha`
- `preUntracked`: set of untracked paths (`git ls-files --others --exclude-standard`)
- `preUntrackedContents`: for each path in `preUntracked`, a content snapshot (hash + bytes, or copy under a temp quarantine dir owned by the adapter). Required so hand edits/deletes of pre-existing untracked can be restored.

After a non-`DONE` hand, adapter MUST:

1. `git reset --hard <freezeCommitSha>` (restores **tracked** files)  
2. Compute `postUntracked` the same way  
3. **Delete every path in `postUntracked - preUntracked`** (hand-created untracked), **including outside `scope_paths`**  
4. For every path in `preUntracked`:  
   - if missing or content hash ≠ snapshot → **restore** from `preUntrackedContents`  
   - if hand deleted it → recreate from snapshot  
5. Do **not** `git clean -fd` blindly without set-difference + restore rules  
6. If any delete/restore fails, set `hand_quarantine: true` and block further hands for that task  

**Invariant restated:** after non-`DONE`, (a) no hand-created untracked remains, (b) operator pre-existing untracked paths and contents match the pre-spawn snapshot, (c) tracked tree matches freeze.

This section is the full contract.

## 5. Run-record (on disk)

Path via path-helpers handRecordPath.  
Must include: featureId, taskId, freezeCommitSha, outcome, touchedPaths, scope violations, frozen violations, timestamps.  
Written by **adapter code**, not by model prose.

---

## 6. test-author + fidelity rail (explicit)

Must exist on OC (04).

| Step | Role | Gate |
|---|---|---|
| Write locked test | test-author | **Allowed without** fidelity-pass (it creates the test) |
| Compliance fidelity check | compliance | validates test matches planner assertion |
| Stamp fidelity-pass + freeze sha | orchestrator/mark | disk markers |
| Implement | executor hand spawn | **Blocked until** fidelity-pass + freeze for that task |

Reintroducing “block all hands until fidelity” without exempting test-author **deadlocks** the rail.

---

## 7. DoD (T7)

- [ ] OC hand adapter at documented path runs subprocess + parses NDJSON  
- [ ] P2 addressed: spawn agents are `mode: primary` (or documented twin pattern)  
- [ ] capture uses shared pure checks + **closed outcome enum** from 03  
- [ ] DONE never derived from prose or exit code alone  
- [ ] FAILED / NOT_DONE / CAPTURE_ERROR follow worktree policy table (reset or quarantine)  
- [ ] FAILED resets to freeze  
- [ ] run-record written on disk by adapter code  
- [ ] fidelity: test-author path not deadlocked  
- [ ] pure tests mandatory; smoke optional  
- [ ] IMPLEMENTATION-TRACK T7 done  

---

## 8. References

- docs/specs/2026-06-12-eyes-strong-hands-cheap.md  
- capture-hand.mjs, dispatch-hand.mjs  
- probe: deny+hallucination, NDJSON types, exit codes  
