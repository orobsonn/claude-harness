# Shipper Plan Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the OpenCode shipper receives the canonical execution-plan path for fresh and resumed delivery runs.

**Architecture:** Keep path resolution in the existing runtime authority. The delivery instruction forwards that resolved value verbatim; the shipper keeps its existing fallback only for an unreadable supplied file.

**Tech Stack:** OpenCode skill Markdown and Node.js hermetic tests.

## Global Constraints

- No new state, gate, permission, dependency, or network call.
- Never reconstruct a resumed plan path from the target session id.
- Preserve the existing feature-id fallback for unreadable input.

---

### Task 1: Forward the canonical path to the shipper

**Files:**
- Modify: `core/opencode/skills/orchestrating-delivery/SKILL.md`
- Test: a new hermetic assertion in the existing OpenCode skill/document contract suite

**Interfaces:**
- Consumes: the runtime-resolved canonical `.opencode/plans/<owner>-<feature>/execution-plan.json` path.
- Produces: a shipper Task brief containing that literal path.

- [x] **Step 1: Write the failing test**

Assert that Phase 5 tells the conductor to pass the resolved canonical path verbatim, and rejects reconstruction from `<sessionID>-<feature_id>` for resumed work.

- [x] **Step 2: Run the targeted test and verify RED**

Run the contract test before changing the skill; it must fail because Phase 5 has no shipper dispatch path instruction.

- [x] **Step 3: Write the minimal instruction**

Add one Phase 5 instruction that dispatches `shipper` with `plan_path` equal to the resolved canonical path and documents the unreadable-file fallback.

- [x] **Step 4: Run the targeted and relevant OpenCode tests**

Run the new contract test plus `core/opencode/lib/feature-resume.test.mjs` to prove fresh and resumed resolution stay correct.

- [ ] **Step 5: Commit**

Commit the skill, test, and issue design/plan using `fix(opencode): injeta plano canônico no shipper (#568)`.
