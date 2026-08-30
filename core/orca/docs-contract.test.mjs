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
 *
 * Plus the four canary facts of #810: the current head-branch format, the entry-gate's ambiguity
 * refusal (pipe/redirect included), worktree ps as liveness-not-progress, and the release-please
 * repo toggle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const DOCS = {
  readme: new URL("../../README.md", import.meta.url),
  usage: new URL("../../docs/usage.md", import.meta.url),
  playbook: new URL("../../docs/orca-headless-vps-playbook.md", import.meta.url),
  fromZero: new URL("../../docs/playbook-vps-agente-ia-do-zero.md", import.meta.url),
  selector: new URL("./README.md", import.meta.url),
  deprecated: new URL("../vps/DEPRECATED.md", import.meta.url),
  kaizen: new URL("../claude-code/kaizen.md", import.meta.url),
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
  // Flattened: the two flags are named as ONE restriction, and which column the author wrapped at
  // is not part of the contract. Order-independent for the same reason — pinning `--repo` BEFORE
  // `-R` pinned a word order nobody promised, and the #810 rewrite broke it without weakening the
  // doc.
  const combined = flat([DOCS.usage, DOCS.playbook, DOCS.selector].map(readDoc).join("\n"));
  assert.match(combined, /entry-gate/);
  assert.match(combined, /`?-R`?\/`?--repo`?|`?--repo`?\/`?-R`?/, "both flags must be named as one restriction");
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

// ---------------------------------------------------------------------------
// #810 — canary learnings: branch name, entry-gate ambiguity, worktree ps, release-please toggle
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * @description Every markdown doc the contract polices: the root README plus everything under
 * `docs/` and `core/`, minus `core/vps/` — issue #807 deletes that tree, so no oracle may grow a
 * dependency on it — and minus `node_modules`/`.git`.
 * @returns {string[]} absolute paths
 */
function markdownDocs() {
  const files = [fileURLToPath(DOCS.readme)];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (path.relative(REPO_ROOT, full) === path.join("core", "vps")) continue;
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  };
  for (const tree of ["docs", "core"]) walk(path.join(REPO_ROOT, tree));
  return files;
}

/** @description Blank-line-delimited [start, end) line ranges. @param {string[]} lines */
function paragraphRanges(lines) {
  const ranges = [];
  let start = null;
  lines.forEach((line, index) => {
    if (line.trim() !== "" && start === null) start = index;
    if (line.trim() === "" && start !== null) {
      ranges.push([start, index]);
      start = null;
    }
  });
  if (start !== null) ranges.push([start, lines.length]);
  return ranges;
}

/**
 * @description Line indices that sit INSIDE a fenced code block. A `# comment` in a shell sample is
 * not a heading: letting it count as one would let an unmarked claim borrow a marker word from a
 * nearby code block, and it makes the failure message point at a line no reader calls a heading.
 * @param {string[]} lines @returns {Set<number>}
 */
function fencedLines(lines) {
  const inside = new Set();
  let open = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      open = !open;
      inside.add(index);
      return;
    }
    if (open) inside.add(index);
  });
  return inside;
}

/** @description A `## ` section, heading → next `## `. @param {string} doc @param {string} heading */
function sliceSection(doc, heading) {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `the doc must carry the section "${heading}"`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * @description Collapses line wraps and blockquote markers so an asserted phrase survives a
 * re-wrap. Doc contracts must pin WORDS, not the column the author happened to break at.
 * @param {string} doc @returns {string}
 */
function flat(doc) {
  return doc.split("\n").map((line) => line.replace(/^\s*>?\s?/, "")).join(" ").replace(/\s+/g, " ");
}

const BRANCH_HEADING = "## O nome do branch é `<owner>/harness-<N>` — e casar prefixo é anti-padrão";

test("#ac-1.1 the selector README pins the CURRENT branch format `<owner>/harness-<N>`, names prefix-matching an anti-pattern, and explains why the review automation's SUFFIX regex still matches", () => {
  const section = flat(sliceSection(readDoc(DOCS.selector), BRANCH_HEADING));
  assert.match(section, /<owner>\/harness-<N>/, "the current head-branch format must be written literally");
  assert.match(
    section,
    /[A-Za-z][\w.-]*\/harness-\d+/,
    "…alongside a concrete owner-prefixed example, not the placeholder alone",
  );
  assert.match(section, /anti-?padr[ãa]o/i, "matching a branch PREFIX must be named an anti-pattern");
  assert.match(section, /estado da issue/i, "the doc must say the right question is the ISSUE's state");
  assert.match(section, /CLOSED/, "…and name the state that means delivered");
  assert.match(section, /kaizen\.md/, "the doc must cross-reference the kaizen entry on branch-name-anchored gates");
  // Without this half a reader "fixes" a selector that is not broken.
  assert.match(section, /\/harness-\[0-9\]\+\$\//, "the review automation's regex must be quoted verbatim");
  assert.match(section, /sufixo/i, "…and explained as a SUFFIX match, which is why the `<owner>/` prefix does not break it");
});

/** Placeholder-shaped mentions only: a FORMAT claim, not a concrete past branch (`harness/84`). */
const OLD_BRANCH_FORMAT = /harness\/(?:<[Nn]>|\$\{?N\}?|N\b)/;
/** Any one of these, in the mention's paragraph or its nearest heading, marks it as history. */
const RETIRED_ENGINE_MARKERS =
  /motor antigo|motor aposentado|aposentad|retirad|retired|legacy|hist[óo]ric|chain-release|cron-a-select/i;

test("#ac-1.2 no doc presents `harness/<N>` as the CURRENT branch format — every mention sits in a paragraph (or under a heading) marked as the retired engine's history", () => {
  let mentions = 0;
  for (const file of markdownDocs()) {
    const lines = readFileSync(file, "utf-8").split("\n");
    const fenced = fencedLines(lines);
    for (const [start, end] of paragraphRanges(lines)) {
      const paragraph = lines.slice(start, end).join("\n");
      if (!OLD_BRANCH_FORMAT.test(paragraph)) continue;
      mentions += 1;
      const heading = lines
        .slice(0, start)
        .reduce((found, line, index) => (!fenced.has(index) && /^#{1,6}\s/.test(line) ? line : found), "");
      assert.match(
        `${heading}\n${paragraph}`,
        RETIRED_ENGINE_MARKERS,
        `${path.relative(REPO_ROOT, file)}:${start + 1} presents \`harness/<N>\` with nothing marking it as the RETIRED engine's format. ` +
          "Either mark it (name the retired engine / `chain-release.mjs` in the same paragraph or its heading), " +
          "or state the CURRENT format instead: `<owner>/harness-<N>`.",
      );
    }
  }
  // Not vacuous, and not an invitation to delete the history: the lesson stays on record.
  assert.ok(mentions >= 1, "the retired engine's `harness/<N>` bug must remain documented somewhere, as history");
  assert.match(
    readDoc(DOCS.kaizen),
    OLD_BRANCH_FORMAT,
    "the kaizen entry `dependency gates must be anchored on delivery STATE` must keep the literal old format it is about",
  );
});

test("#ac-2.1 every doc that shows the merge command states the entry-gate refuses an ambiguous target — pipe and redirect included — and none of them SHOWS `-R`/`--repo` on a merge command", async () => {
  const { reviewAutomationGuide } = await import(
    "../claude-code/skills/initializing-projects/references/setup-vps.mjs"
  );
  const sites = [
    ["core/orca/README.md", readDoc(DOCS.selector)],
    ["docs/usage.md", readDoc(DOCS.usage)],
    ["docs/orca-headless-vps-playbook.md", readDoc(DOCS.playbook)],
    ["the setup-vps printed guide", reviewAutomationGuide()],
  ];
  for (const [name, doc] of sites) {
    const flatDoc = flat(doc);
    assert.match(flatDoc, /entry-gate/, `${name} must name the gate`);
    assert.match(flatDoc, /amb[íi]gu/i, `${name} must say the gate refuses an ambiguous target`);
    assert.match(flatDoc, /-R\b/, `${name} must name the -R half of the restriction`);
    assert.match(flatDoc, /--repo/, `${name} must name the --repo half of the restriction`);
    assert.match(flatDoc, /\bpipe\b/i, `${name} must say a PIPE in the same command makes the target ambiguous`);
    assert.match(flatDoc, /redirecionamento|redirect/i, `${name} must say a REDIRECT does too`);
    // The literal the operator will grep when the terminal denies the merge. Measured against the
    // live hook (entry-gate.mjs:779/787); duplicated on purpose — it is a constant, not prose. Flattened
    // because a printed 78-column CLI guide legitimately wraps mid-sentence.
    assert.match(
      flatDoc,
      /PR target is ambiguous; merge is denied\./,
      `${name} must quote the gate's real refusal line verbatim`,
    );
    // "Shows" is the AC's word: an EXAMPLE command must not carry the flag. Prose that forbids the
    // flag necessarily mentions it, so only command-shaped lines are policed.
    for (const line of doc.split("\n")) {
      if (!/^\s*>?\s*gh pr merge\b/.test(line)) continue;
      // A measured refusal line is evidence, not an instruction: it exists precisely to show what
      // the gate rejects, so it may carry the flag it is being rejected for.
      if (/\[entry-gate\] Blocked:/.test(line)) continue;
      assert.doesNotMatch(
        line,
        /(^|\s)(-R\b|--repo\b|--repo=)/,
        `${name} shows a merge command carrying -R/--repo: ${line.trim()}`,
      );
    }
  }
});

test("#ac-2.2 the docs state the entry-gate is DESIRED and must stay — never an obstacle to work around", () => {
  for (const key of ["selector", "usage", "playbook"]) {
    assert.match(
      flat(readDoc(DOCS[key])),
      /feature,? n[ãa]o obst[áa]culo/i,
      `${key} must say the gate is a feature, not an obstacle`,
    );
  }
  const selector = flat(readDoc(DOCS.selector));
  assert.match(selector, /deve continuar assim/i, "the canonical site must say the gate must STAY");
  assert.match(selector, /n[ãa]o contorne/i, "…and forbid working around it");
  assert.match(
    selector,
    /adapte o comando ao gate/i,
    "…in the sentence that settles which side adapts",
  );
});

const LIVENESS_HEADING = "## Sinal de vida ≠ sinal de progresso (`orca worktree ps`)";

test("#ac-3.1 the selector README separates LIVENESS from PROGRESS: `orca worktree ps` feeds the concurrency ceiling; commits and the PR are what say a run moved", () => {
  const section = flat(sliceSection(readDoc(DOCS.selector), LIVENESS_HEADING));
  assert.match(section, /orca worktree ps/, "the section must be about the command it names");
  assert.match(section, /agente vivo/i, "`worktree ps` must be stated as a LIVENESS signal");
  assert.match(section, /globalMaxWorking/, "…whose job here is feeding the concurrency ceiling");
  assert.match(section, /n[ãa]o diz onde a run est[áa]/i, "the doc must deny it as a PROGRESS signal");
  assert.match(section, /minutos/i, "the last-message lag must be quantified as MINUTES, not 'a bit'");
  assert.match(section, /commits? e o PR/i, "real progress must be named: commits and the PR");
  assert.match(section, /gh pr list/, "…with a runnable way to ask for the PR");
  assert.match(section, /git .*log/, "…and a runnable way to ask for the commits");
});

test("#ac-4.1 the repo SETUP checklist carries the release-please toggle, with the symptom that does not look like a permission error", () => {
  const usage = flat(readDoc(DOCS.usage));
  assert.match(usage, /can_approve_pull_request_reviews/, "the API-level toggle name must be greppable");
  assert.match(
    usage,
    /Allow GitHub Actions to create and approve pull requests/,
    "…and the exact label the operator clicks in Settings → Actions → General",
  );
  assert.match(usage, /release-please/i, "the item must say which tool needs it");
  assert.match(usage, /cria o branch e a commit/i, "the symptom: the action gets as far as branch + commit");
  assert.match(usage, /falha\s+\*{0,2}na abertura do PR/i, "…and fails AT PR CREATION");
  assert.match(usage, /n[ãa]o parece de permiss[ãa]o/i, "…with an error that does not look like a permission error");
});

test("#ac-4.2 the checklist records the neighbouring symptom (github-actions[bot] PR, CI `action_required`, zero jobs, gate correctly denying) and does NOT claim the toggle cures the default-GITHUB_TOKEN case", () => {
  const rawUsage = readDoc(DOCS.usage);
  const usage = flat(rawUsage);
  assert.match(usage, /github-actions\[bot\]/, "the PR's author must be named");
  assert.match(usage, /action_required/, "the CI state must be named literally");
  assert.match(usage, /zero jobs/i, "…including that no job materializes");
  assert.match(usage, /aprovar o workflow run/i, "…and that a human must approve the workflow run");
  assert.match(usage, /corretamente/i, "the doc must say the entry-gate is RIGHT to deny while the rollup is empty");
  assert.match(rawUsage, /No CI checks are reported; merge is denied\./, "…quoting the gate's real line");
  // The trap this half exists to prevent: believing the toggle fixes everything.
  assert.match(usage, /GITHUB_TOKEN/, "the case the toggle does NOT cure must be named");
  assert.match(usage, /n[ãa]o cura esse caso/i, "…and explicitly excluded from the toggle's effect");
  assert.match(usage, /releasing-versions/, "the checklist must POINT AT the skill");
  // Cross-reference, not a second copy: the procedure lives in the skill and drifts if duplicated.
  assert.doesNotMatch(usage, /Approve and run/i, "the unblock steps belong to the releasing-versions skill");
  assert.doesNotMatch(usage, /actions\/runs\/\{run_id\}\/approve/, "…same for the approve API call");
});
