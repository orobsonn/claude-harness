# Probe results — OpenCode 1.17.18 (2026-07-10)

**Method:** isolated project under `/var/folders/.../oc-port-probes` with relative plugin, project agents/skills, Grok via xAI OAuth.  
**Binary:** `opencode` 1.17.18 (`~/.opencode/bin/opencode`).

---

## Credentials observed

- xAI: OAuth  
- Ollama Cloud: api  
- Google: GEMINI_API_KEY  
- **OpenAI: not authenticated** (dual real OpenAI not runnable)

---

## Results matrix

| ID | Question | Result | Evidence |
|---|---|---|---|
| P1 | Project plugin loads (relative path)? | YES | `PLUGIN_INIT directory=.../oc-port-probes` |
| P2 | `mode: subagent` as `--agent`? | NO — falls back to default primary | stderr warning |
| P3 | `chat.message` / `chat.params` fire? | YES | hook log; params mutable |
| P4 | Set `reasoningEffort` on grok-build? | NO — API 400 | `Model grok-build-0.1 does not support parameter reasoningEffort` |
| P5 | Simple primary agent run? | YES | `LOCKED_OK`, exit 0 |
| P6 | bash tool works? | YES | `HAND_OPEN_BASH_OK` |
| P7 | `task` dispatch to project subagent? | YES | with `--pure` or after ceremony |
| P8 | Global plugins also load? | YES | first `task` denied by **global** entry-gate; model ran triage+classify then retried |
| P9 | `--pure`? | Disables **all** plugins including project | no PLUGIN_INIT; task works without gates |
| P10 | `throw` in before blocks tool? | YES | `PROBE_DENIED:bash`, tool status error |
| P11 | Process exit on deny? | 0 | P4B_EXIT=0 |
| P12 | Model may hallucinate after deny? | YES | bash denied but text still `HAND_OPEN_BASH_OK` |
| P13 | Invalid `subagent_type`? | Explicit error | `Unknown agent type: zzz-does-not-exist` (not silent generic) |
| P14 | Project skill via `skill` tool? | YES | `SKILL_LOADED_OK` |
| P15 | Project `AGENTS.md`? | YES | `PROJECT_AGENTS_SEEN` |
| P16 | Dual sequential `task`? | YES | EYE_A + EYE_B CLEAN |
| P17 | `xai/grok-4.3`? | YES | ORCH43_OK |
| P18 | `--variant high`? | YES | exit 0 with 4.3 |
| P19 | `openai/gpt-5.5` without auth? | FAIL | Unexpected server error / no provider |
| P20 | NDJSON types? | step_start, tool_use, step_finish, text, error | step_finish includes tokens+cost |
| P21 | Config load paths? | Many | global ~/.config/opencode, project opencode.json, project .opencode/opencode.json, ~/.opencode, OPENCODE_CONFIG_DIR |
| P22 | Subagent parentID? | YES | log parentID=... |
| P23 | Nested task on subagent? | denied by default permissions | task deny on child session |
| P24 | task tool schema fields? | description, prompt, subagent_type, task_id, command, background | **no model, no variant** |
| P25 | xAI catalog coding models | build-0.1, 4.3, 4.5, 4.20-*; multi-agent toolcall false | `opencode models xai` |

---

## Implications locked into specs

1. Cutover global required (10)  
2. Capture oracle mandatory (06)  
3. Effort flags model-specific (02, 03)  
4. Dual = two agents/tasks (07)  
5. Exit code not session oracle (09)  
6. build.md “silent fallback” claim outdated for unknown types (04)  
7. **P2:** `opencode run --agent` requires `mode: primary` — hand spawn agents cannot be subagent-only (04, 06)  
8. **P12:** denied tool + hallucinated success text → never trust prose (06)  

---

## Probe artifacts location

Ephemeral dir used during session; this document is the durable record.
