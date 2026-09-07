---
name: measuring-cost
description: "Use at the end of a delivery (invoked by the harvester) to report the API-equivalent cost of the session plus the weekly Claude Code consumption trend. Wraps the `ccusage` tool over the local transcript JSONL; fail-soft when ccusage is unreachable (offline / cloud headless)."
---

# Measuring-Cost — per-delivery cost + weekly consumption proxy

**Announce at the start (in pt-br):** "Usando measuring-cost para medir o custo da entrega."

This skill surfaces, in product-language for the operator, two numbers:
- **Session cost** — the API-equivalent dollar cost of the current run, with a per-model breakdown.
- **Weekly trend** — total Claude Code consumption this week vs. last week (spans **all** projects, since `ccusage` reads every transcript).

The weekly figure is a **real consumption proxy, not a subscription %** — Anthropic's subscription limits are opaque, model-weighted, and rolling-window, so no honest token→% mapping exists. Report the relative number; never invent a percentage.

## Prerequisite — ccusage

The script depends on **ccusage** (reads Claude Code's local transcript JSONL and prices it per model). Docs and install: **https://github.com/ryoppippi/ccusage** (npm: `ccusage`).

No manual install is required — the script calls `npx -y ccusage@latest`, which fetches it on demand. For faster repeated runs the operator may install it globally (`npm i -g ccusage`) or use `bunx ccusage`. If neither npx nor network is available (cloud headless), the script degrades to "indisponível" — by design.

## How to run

```bash
node .claude/skills/measuring-cost/references/cost-report.mjs
```

Optionally pin the session with `--session-id <id>` (the orchestrator's session id, from the gate state dir name under `.claude/plans/.state/`). Without it, the script reports the most-recently-active session — which during a live harvest is the current run.

The script:
- shells out to `npx ccusage@latest session --json` and `weekly --json`,
- is **fail-soft**: any failure (ccusage absent, offline, no network in cloud) yields a graceful "custo indisponível" line instead of an error — never block the harvest on it,
- prints a ready-to-paste pt-br markdown block.

## How to report

Paste the script's output verbatim into the harvest summary (and, in HEADLESS, into the PR body). Do **not** persist cost numbers into committed files (`.claude/memory/`, CHANGELOG) — they are run telemetry, not durable knowledge, and would be noise in git.

## Caveats to keep honest

- **Sub-agent granularity:** each dispatched sub-agent has its own transcript file, so the "session" number is the orchestrator's; sub-agent spend rolls into the daily/weekly totals. Say so — do not present the session number as the whole delivery cost.
- **Headless/cloud:** if the transcript JSONL or `npx` is unavailable in the cloud sandbox, the script degrades to "indisponível". That is expected; the local run is where the number is reliable.
