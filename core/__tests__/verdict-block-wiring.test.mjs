/**
 * @description Verifies the verdict-block wiring between the orchestrator and the shipper:
 * shipper.md must instruct embedding the machine-readable formatVerdictBlock() output into
 * the PR body, and orchestrating-delivery/SKILL.md's Phase 3 (final dual review) must
 * instruct producing/computing the CLEAN/BLOCKED verdict block and passing it to the shipper.
 * Currently RED: neither .md file mentions formatVerdictBlock yet.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("shipper.md instructs embedding formatVerdictBlock's output into the PR body", () => {
  const shipperPath = resolve(__dirname, "../agents/shipper.md");
  const shipperContent = readFileSync(shipperPath, "utf8");

  assert(
    shipperContent.includes("formatVerdictBlock"),
    "shipper.md must reference formatVerdictBlock for the machine-readable verdict block"
  );

  const embeddingInstruction = shipperContent.match(
    /formatVerdictBlock[\s\S]{0,400}PR body|PR body[\s\S]{0,400}formatVerdictBlock/i
  );
  assert(
    embeddingInstruction !== null,
    "shipper.md must co-locate an instruction to embed the formatVerdictBlock output into the PR body"
  );
});

test("orchestrating-delivery/SKILL.md Phase 3 instructs producing the CLEAN/BLOCKED verdict block and passing it to the shipper", () => {
  const skillPath = resolve(__dirname, "../skills/orchestrating-delivery/SKILL.md");
  const skillContent = readFileSync(skillPath, "utf8");

  const phase3Match = skillContent.match(
    /## Phase 3[\s\S]*?(?=\n## Phase 4|$)/
  );
  assert(
    phase3Match !== null,
    "SKILL.md must have a Phase 3 (final dual review) section"
  );
  const phase3Content = phase3Match[0];

  assert(
    phase3Content.includes("formatVerdictBlock"),
    "Phase 3 must instruct producing the verdict block via formatVerdictBlock"
  );
  assert(
    /CLEAN/.test(phase3Content) && /BLOCKED/.test(phase3Content),
    "Phase 3 must name both the CLEAN and BLOCKED verdict outcomes"
  );
  assert(
    /shipper/i.test(phase3Content),
    "Phase 3 must instruct passing the computed verdict block to the shipper"
  );
});
