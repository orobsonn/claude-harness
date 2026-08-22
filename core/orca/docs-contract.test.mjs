/**
 * @description Docs oracle for the Orca-dispatch design. It REPLACES
 * `core/vps/docs-review-phase.test.mjs`, which pinned the retired VPS engine's review-cron contract
 * (`HARNESS_REVIEW_ENABLED`, the every-6-hours review cadence, the `autoMergeEnabled` rollout lock) into
 * `docs/usage.md` — knobs that no longer describe how anything runs. Deleting that oracle without
 * replacing it would have left the current contract unpinned, so the merge criteria and the
 * entry-gate consequence are asserted here instead.
 *
 * What must stay true in the docs: Orca is named as the official ADE with a download link; the
 * design is described as two LAYERS (Orca dispatches, the repo's vendored `.claude/` executes); the
 * PR-review automation's merge criteria are stated; and the `entry-gate` consequence (no `-R` on the
 * merge command) is written down, because it is the one constraint an operator would otherwise
 * discover only by having a merge denied.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const DOCS = {
  readme: new URL("../../README.md", import.meta.url),
  usage: new URL("../../docs/usage.md", import.meta.url),
  playbook: new URL("../../docs/orca-headless-vps-playbook.md", import.meta.url),
  fromZero: new URL("../../docs/playbook-vps-agente-ia-do-zero.md", import.meta.url),
  selector: new URL("./README.md", import.meta.url),
  deprecated: new URL("../vps/DEPRECATED.md", import.meta.url),
};

/** @param {URL} fileUrl @returns {string} */
function readDoc(fileUrl) {
  try {
    return readFileSync(fileUrl, "utf-8");
  } catch (error) {
    throw new Error(`expected doc to exist at ${fileUrl}: ${error.message}`);
  }
}

test("Orca is named the official ADE, with a download link, in the README and in EVERY playbook", () => {
  for (const key of ["readme", "playbook", "fromZero"]) {
    const doc = readDoc(DOCS[key]);
    assert.match(doc, /ADE oficial/i, `${key} must name Orca as the official ADE`);
    assert.match(doc, /https:\/\/onorca\.dev/, `${key} must carry the Orca download link`);
    assert.match(
      doc,
      /https:\/\/github\.com\/stablyai\/orca\/releases/,
      `${key} must carry the Orca releases link`,
    );
  }
  assert.match(readDoc(DOCS.usage), /https:\/\/onorca\.dev/, "usage.md must carry the Orca download link");
});

test("the docs describe TWO LAYERS (Orca dispatches, the repo's vendored .claude/ executes), not two engines", () => {
  const combined = [DOCS.readme, DOCS.usage, DOCS.playbook].map(readDoc).join("\n");
  assert.match(combined, /duas camadas, n[ãa]o dois motores/i);
  assert.match(combined, /vendorad[oa]/i);
  assert.match(combined, /core\/orca\/select-and-dispatch\.mjs/);
});

test("the PR-review automation's merge criteria are documented, including the mandatory --match-head-commit", () => {
  const combined = [DOCS.usage, DOCS.playbook, DOCS.selector].map(readDoc).join("\n");
  assert.match(combined, /--match-head-commit/, "the merge must be pinned to a head sha");
  assert.match(combined, /ARMADO de severidade alta/i, "no armed high-severity finding may merge");
  assert.match(combined, /SUCCESS/, "CI must have concluded SUCCESS");
  assert.match(combined, /conflito/i, "a conflicting PR must not merge");
});

test("the entry-gate consequence is written down: the merge command cannot pass -R/--repo", () => {
  const combined = [DOCS.usage, DOCS.playbook, DOCS.selector].map(readDoc).join("\n");
  assert.match(combined, /entry-gate/);
  assert.match(combined, /-R\/--repo|--repo.*-R/);
  assert.match(combined, /amb[íi]gu/i, "the gate denies an ambiguous merge target");
});

test("core/vps is documented as retired, and its removal is gated on a verification runbook rather than a blind delete", () => {
  const deprecated = readDoc(DOCS.deprecated);
  assert.match(deprecated, /APOSENTADO/);
  assert.match(deprecated, /run-drain/, "the runbook must name the crontab entries other projects may still have");
  assert.match(deprecated, /run-reaper/);
  assert.match(deprecated, /crontab -l/, "the runbook must show how to inventory the surviving crons");
  assert.match(readDoc(DOCS.readme), /core\/vps\/DEPRECATED\.md/, "the README must point at the retirement notice");
});

test("the two measured failures are recorded where an operator will hit them — canary filter and CLOSED-issue dependency gate", () => {
  const selector = readDoc(DOCS.selector);
  assert.match(selector, /titleIncludes/);
  assert.match(selector, /can[áa]ri/i);
  assert.match(selector, /CLOSED/);
  assert.match(selector, /chain-validate/, "the doc must record that the old validator could not see this failure class");
});

// ---------------------------------------------------------------------------
// Operating the VPS from an agent session — the barriers that read as "no access"
// ---------------------------------------------------------------------------

const AGENT_SECTION_HEADING = "## 8. Operando a VPS a partir de uma sessão de agente";

/**
 * @description Slices the playbook's agent-session section (heading → next `## ` heading).
 * @returns {string}
 */
function agentSection() {
  const doc = readDoc(DOCS.playbook);
  const start = doc.indexOf(AGENT_SECTION_HEADING);
  assert.notEqual(start, -1, `the playbook must carry the section "${AGENT_SECTION_HEADING}"`);
  const rest = doc.slice(start + AGENT_SECTION_HEADING.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const DIAGNOSTIC_HEADER = "| Mensagem | Causa provável | Ação |";

/**
 * @description Returns the diagnostic table's DATA rows (header and separator dropped), sliced from
 * its header to the first non-table line. Counting every line that starts with `|` inside the whole
 * section was wrong: a pipe inside a fenced code block (`| jq ...`) counted as a row and failed the
 * oracle against an untouched table, telling the next author to edit BARRIERS.
 * @param {string} section
 * @returns {string[]}
 */
/**
 * @description The cells of a markdown table row, without the leading/trailing empties.
 * @param {string} row
 * @returns {string[]}
 */
function cellsOf(row) {
  return row.trim().split("|").slice(1, -1);
}

function diagnosticRows(section) {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.trim() === DIAGNOSTIC_HEADER);
  assert.notEqual(start, -1, `the section must carry the diagnostic table header: ${DIAGNOSTIC_HEADER}`);
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim().startsWith("|")) break;
    if (/^\|[\s|:-]+\|$/.test(line.trim())) continue; // markdown separator
    rows.push(line);
  }
  return rows;
}

test("every barrier the doctor can diagnose has a row in the playbook, carrying that barrier's fix", async () => {
  // The doctor's table is the single source of the fixes it prints. If a fix could live in code
  // without living in the doc the operator reads, the next agent hits the barrier with no way out —
  // which is exactly the incident this section was written for.
  const { BARRIERS } = await import("../claude-code/skills/connecting-orca/references/orca-doctor.mjs");
  const rows = diagnosticRows(agentSection());

  // The token must live in the ACTION cell, not merely somewhere on the line: a fix that appears in
  // the "cause" column is a description, and the operator acts on the last column.
  // Honest limit: this pins PRESENCE, not truthfulness — a row could carry the token and still tell
  // the reader to do the opposite. Only a reader (or an adversarial pass) catches that; the oracle
  // exists to stop the drift that silence produces, not to referee prose.
  for (const barrier of BARRIERS) {
    const row = rows.find((line) => cellsOf(line)[0]?.includes(barrier.symptom));
    assert.ok(row, `no diagnostic row for the symptom "${barrier.symptom}" (barrier ${barrier.id})`);
    const action = cellsOf(row).at(-1) ?? "";
    assert.ok(
      action.includes(barrier.docToken),
      `the ACTION cell for "${barrier.symptom}" must carry its fix (expected "${barrier.docToken}"): ${action}`,
    );
  }

  // Bidirectional, by CONTENT not by count: a row nobody can diagnose is a fix the doctor will never
  // print, and the operator would follow advice no probe can ever produce.
  for (const row of rows) {
    assert.ok(
      BARRIERS.some((b) => cellsOf(row)[0]?.includes(b.symptom)),
      `this diagnostic row matches no barrier the doctor can classify: ${row}`,
    );
  }
  assert.equal(rows.length, BARRIERS.length, "one row per barrier, no more");
});

test("the section states the SSH-free shortcut AND what it cannot do — the split that decides the repair", () => {
  const section = agentSection();
  assert.match(section, /--environment/, "the CLI shortcut must be named");
  assert.match(section, /orca repo list\s+--environment/, "with a runnable example");
  for (const sshOnly of [/crontab/i, /systemctl/i, /\.config\/claude-harness/]) {
    assert.match(section, sshOnly, "the doc must name what still requires SSH");
  }
  assert.match(section, /orca-doctor/, "the deterministic diagnosis must be reachable from the doc");
  assert.match(section, /connecting-orca/, "the end-to-end path must be reachable from the doc");
});

test("no doc still tells the operator to run `orca repo ls` — the build refuses it", () => {
  // Measured on the live AppImage: `repo ls` answers ok:false / exit 1 with
  // suggestions:["repo list","repo add"]. Following the old instruction leaves an operator with no
  // repo id, i.e. stuck at the first step of wiring the queue.
  for (const key of ["playbook", "usage", "selector", "readme"]) {
    const doc = readDoc(DOCS[key]);
    for (const line of doc.split("\n")) {
      if (/`repo ls` (NÃO|não) existe|Unknown command/.test(line)) continue; // the rows that document the refusal
      assert.doesNotMatch(line, /orca repo ls/, `${key} still instructs \`orca repo ls\`: ${line}`);
    }
  }
});
