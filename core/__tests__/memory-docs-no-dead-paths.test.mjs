/**
 * @description Oracle for issue #832: a `core/<shell>/memory/` doc must never present a DEAD
 * repo-rooted path as a CURRENT fact. PR #830 deleted `core/vps/` (the retired VPS cron engine);
 * several memory docs still cite paths under it, and one (`outbox-event-ts-field-comparison.md`)
 * cites a `core/hooks/` address that was never even correct. The fix per file is either REPOINT (the
 * module moved to a real new address) or MARK HISTORICAL (`[RETIRED ENGINE]` or a
 * `docs/vps-retirement.md` link in the citation's scope window) — never silent deletion: the durable
 * value of these docs is the LESSON the trap taught, not the file path (`nao_apagar_historia`).
 *
 * This is a DELIBERATELY narrower, DELIBERATELY incompatible convention from
 * `core/orca/docs-contract.test.mjs`'s `RETIRED_ENGINE_MARKERS` (a loose `/retired|legacy|.../i` word
 * scan over `docs/` + `core/`, built for issue #810's `harness/<N>` branch-format bug). That scan is a
 * `node:test` file — importing its helpers would re-register and re-run its whole suite — so
 * `paragraphRanges`/`fencedLines`-shaped helpers are duplicated here, not imported, with a stricter
 * marker (two exact, deliberate, path-shaped literals) and a stricter block boundary (see below) built
 * for THIS job: distinguishing a dead-path CITATION from prose that merely uses the word "retired".
 *
 * Known, deliberate residual holes (documented here rather than engineered away — none justify more
 * machinery for this issue):
 *   (a) a citation embedded in a shell command, e.g. `git show HEAD:core/vps/run-reaper.mjs`, is
 *       invisible to the tokenizer (its first segment is `HEAD:core`, not a repo-root dir) — memory
 *       authors must mark such mentions by hand (reaper-multi-repo-gh-scoping.md does).
 *   (b) a marker in a file's OWN title/`description:` is a permanent whole-file blanket: once a file
 *       declares itself historical, this oracle can never catch a *new* dead-and-unmarked path added
 *       to it later. That is the intentional meaning of marking the title (#832 spec §1).
 *   (c) a non-repo-rooted dead path (bare `vps/run-reaper.mjs`, `.claude/vps/obs-outbox.mjs`) is never
 *       a citation — only tokens whose first segment is a real top-level repo directory are scanned,
 *       which is also what keeps illustrative `.claude/...` example paths out of the scan.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const CORE = path.join(REPO_ROOT, "core");

/**
 * @description `core/<shell>/memory` for every shell directory that HAS a `memory/` subdir today.
 * No shell name is written here on purpose (#ac-X.2): `core/opencode/memory/` enters this list by
 * EXISTING on disk, not by being added to a list. `Dirent.isDirectory()` is false for a symlink, so
 * the legacy `core/memory -> claude-code/memory` alias is skipped and nothing is double-scanned.
 * @returns {string[]}
 */
function deriveShellMemoryDirs() {
  return readdirSync(CORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CORE, entry.name, "memory"))
    .filter((dir) => existsSync(dir));
}

/** @description Non-dot, non-`node_modules` top-level repo directories — the universe a citation's first segment must belong to. @returns {Set<string>} */
function topLevelRepoDirs() {
  return new Set(
    readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules"),
  );
}

/** @param {string} dir @returns {string[]} absolute paths of the `.md` files directly inside `dir` */
function memoryDocsIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * @description Memory prose wraps at ~100 cols and a path breaks either after a `/`
 * (`secret-shaped-fixture-fragmentation.md:8`) or after a `-`
 * (`rule-reach-requires-agent-contract.md:23` wraps `core/skills/initializing-` /
 * `projects/references/vendor-core.mjs`). Join forward while the line looks like it ends mid-path;
 * report the line the citation STARTS on so failure messages point at real prose.
 * @param {string[]} rawLines @returns {{text: string, line: number}[]}
 */
function dewrap(rawLines) {
  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    let text = rawLines[i].trimEnd();
    let j = i;
    while (j + 1 < rawLines.length && /(?:^|\s)[^\s`]*\/[^\s`]*[-/]$/.test(text)) {
      text += rawLines[++j].trim();
    }
    out.push({ text, line: i + 1 });
  }
  return out;
}

const EXTENSIONS = /\.(?:mjs|js|md|json)$/;
const PLACEHOLDER_CHARS = /[<>{}$*]/;
const BARE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * @description Does `token` qualify as a repo-rooted path citation? Tokens containing placeholder
 * punctuation are skipped. A token qualifies when its first segment is a real top-level repo dir AND
 * it is (1) >=2 segments ending in a known extension, (2) ends in `/` (a bare directory citation, the
 * `core/vps/` shape), or (3) exactly 2 segments with no extension matching a bare-word second segment
 * (the `core/vps` shape with no trailing slash, used in two `description:` lines).
 * @param {string} token @param {Set<string>} topLevelDirs @returns {boolean}
 */
function qualifiesAsCitation(token, topLevelDirs) {
  if (token.length === 0 || PLACEHOLDER_CHARS.test(token)) return false;
  const first = token.split("/")[0];
  if (!topLevelDirs.has(first)) return false;
  const endsWithSlash = token.endsWith("/");
  const segments = token.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (endsWithSlash) return true;
  const last = segments[segments.length - 1];
  if (EXTENSIONS.test(last)) return true;
  if (segments.length === 2 && BARE_SEGMENT.test(segments[1])) return true;
  return false;
}

/**
 * @description Pull repo-rooted path citations out of one (possibly dewrapped) line of prose.
 * Splits on backtick/quote/bracket/paren/comma/semicolon/space so a backticked path — the form nearly
 * every citation in these docs takes — is not swallowed whole with its surrounding punctuation.
 * @param {string} text @param {Set<string>} topLevelDirs @returns {string[]}
 */
function tokenizeCitations(text, topLevelDirs) {
  return text
    .split(/[\s`'"()[\],;]+/)
    .map((raw) => raw.replace(/^[`'"([]+/, "").replace(/[.,;:)\]`]+$/, ""))
    .filter((token) => qualifiesAsCitation(token, topLevelDirs));
}

/**
 * @description Block ranges for the "scope window" a historical marker may live in. A blank-line-only
 * paragraph definition would let ONE bullet's `[RETIRED ENGINE]` badge excuse every OTHER bullet in
 * the same tight list (these docs write bullet lists with no blank line between items) — so a block
 * also ends, and a new one begins, at the next top-level list item.
 * @param {string[]} lines @returns {[number, number][]} half-open [start, end) line-index ranges
 */
function blockRanges(lines) {
  const ranges = [];
  let start = null;
  lines.forEach((line, index) => {
    const blank = line.trim() === "";
    const bulletStart = /^\s{0,3}[-*]\s/.test(line);
    if (start !== null && (blank || bulletStart)) {
      ranges.push([start, index]);
      start = null;
    }
    if (start === null && !blank) start = index;
  });
  if (start !== null) ranges.push([start, lines.length]);
  return ranges;
}

/** @param {string[]} lines @returns {Set<number>} line indices inside a fenced code block */
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

/** @param {number} lineIndex @param {[number, number][]} ranges @returns {[number, number]} */
function blockContaining(lineIndex, ranges) {
  return ranges.find(([start, end]) => lineIndex >= start && lineIndex < end) ?? [lineIndex, lineIndex + 1];
}

/** @param {string[]} lines @param {Set<number>} fenced @param {number} beforeIndex @returns {string} nearest preceding non-fenced heading, or "" */
function nearestHeading(lines, fenced, beforeIndex) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (!fenced.has(i) && /^#{1,6}\s/.test(lines[i])) return lines[i];
  }
  return "";
}

/** @param {string} raw full file text @returns {string} the file's H1 title plus its frontmatter `description:` value, if any */
function fileIdentity(raw) {
  const title = raw.match(/^#\s.*$/m)?.[0] ?? "";
  const description = raw.match(/^description:\s*(.*)$/m)?.[1] ?? "";
  return `${title}\n${description}`;
}

// Case-sensitive, deliberately narrow, and deliberately NOT loose words like "retired"/"legacy" (an
// incidental use of the English word must never excuse a dead path): only these two literals mark a
// citation as historical rather than current.
const HISTORICAL_MARKER = /\[RETIRED ENGINE\]|docs\/vps-retirement\.md/;

/** @typedef {{file: string, line: number, token: string, dead: boolean, marked: boolean}} CitationCheck */

/**
 * @description Every repo-rooted path citation in `file` — ALIVE ones included, so the citation-count
 * anti-vacuity floor measures the tokenizer's real reach, not just its dead-path hits — each resolved
 * to dead/alive and, for a dead one, whether its scope window (own block + nearest preceding heading +
 * file title/description) carries the historical marker.
 * @param {string} file @param {Set<string>} topLevelDirs @returns {CitationCheck[]}
 */
function checkFile(file, topLevelDirs) {
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n");
  const fenced = fencedLines(lines);
  const ranges = blockRanges(lines);
  const identity = fileIdentity(raw);
  const results = [];
  for (const { text, line } of dewrap(lines)) {
    for (const token of tokenizeCitations(text, topLevelDirs)) {
      const dead = !existsSync(path.join(REPO_ROOT, token));
      if (!dead) {
        results.push({ file, line, token, dead: false, marked: true });
        continue;
      }
      const lineIndex = line - 1;
      const [start, end] = blockContaining(lineIndex, ranges);
      const block = lines.slice(start, end).join("\n");
      const heading = nearestHeading(lines, fenced, start);
      const window = `${heading}\n${block}\n${identity}`;
      results.push({ file, line, token, dead: true, marked: HISTORICAL_MARKER.test(window) });
    }
  }
  return results;
}

const shellMemoryDirs = deriveShellMemoryDirs();
const memoryDocs = shellMemoryDirs.flatMap(memoryDocsIn);
const topLevelDirs = topLevelRepoDirs();

test("#ac-1.2 no memory doc cites a path that does not exist as CURRENT", () => {
  // Anti-vacuity: a green run must mean something was actually scanned.
  assert.ok(shellMemoryDirs.length >= 1, "no core/<shell>/memory directory found — the scan would pass vacuously");
  assert.ok(
    memoryDocs.length >= 12,
    `only ${memoryDocs.length} memory docs scanned — the layout moved; fix the walk, don't lower this floor`,
  );

  let citations = 0;
  let deadUnmarked = [];
  let deadMarked = 0;
  for (const doc of memoryDocs) {
    const checks = checkFile(doc, topLevelDirs);
    citations += checks.length;
    for (const check of checks) {
      if (!check.dead) continue;
      if (check.marked) deadMarked += 1;
      else deadUnmarked.push(check);
    }
  }

  // Anti-vacuity for the tokenizer itself: a tokenizer that stops matching backticked paths (the form
  // nearly every citation in these docs takes) would silently scan ~5 citations instead of ~35 and go
  // green and blind. This floor makes that regression fail instead of passing quietly.
  assert.ok(
    citations >= 25,
    `only ${citations} repo-rooted path citations found across ${memoryDocs.length} memory docs — ` +
      "there are 35+ today. A tokenizer that stops matching backticked paths turns this oracle green " +
      "and blind; fix the tokenizer, never lower this floor.",
  );

  for (const bad of deadUnmarked) {
    assert.fail(
      `${path.relative(REPO_ROOT, bad.file)}:${bad.line} cites \`${bad.token}\`, which does not exist ` +
        "on disk, with nothing marking it as history. Either REPOINT it to the module's real address, " +
        "or mark the mention: add `[RETIRED ENGINE]` (or a link to `docs/vps-retirement.md`) to this " +
        "block, its nearest heading, or the file's title/description. Do NOT delete the mention — the " +
        "lesson is the durable part (#832).",
    );
  }

  // Refuse to reward deletion: the fix for a dead path is a marker, not silence. If nothing in the
  // whole memory corpus mentions the retired engine any more, history was erased rather than marked.
  assert.ok(
    deadMarked >= 1,
    "no memory doc mentions the retired engine any more — history was deleted rather than marked (#832 `nao_apagar_historia`)",
  );
});

test("#ac-1.2 every `core/vps` mention in memory sits in a window marked as the retired engine", () => {
  let mentions = 0;
  let markedMentions = 0;
  for (const doc of memoryDocs) {
    const raw = readFileSync(doc, "utf-8");
    const lines = raw.split("\n");
    const fenced = fencedLines(lines);
    const ranges = blockRanges(lines);
    const identity = fileIdentity(raw);
    lines.forEach((line, index) => {
      const matches = line.match(/core\/vps/g);
      if (!matches) return;
      const [start, end] = blockContaining(index, ranges);
      const block = lines.slice(start, end).join("\n");
      const heading = nearestHeading(lines, fenced, start);
      const window = `${heading}\n${block}\n${identity}`;
      const marked = HISTORICAL_MARKER.test(window);
      for (let k = 0; k < matches.length; k++) {
        mentions += 1;
        if (marked) markedMentions += 1;
        assert.ok(
          marked,
          `${path.relative(REPO_ROOT, doc)}:${index + 1} mentions \`core/vps\` (the retired VPS ` +
            "engine, deleted in #807) with nothing marking it as history. Add `[RETIRED ENGINE]` or a " +
            "`docs/vps-retirement.md` link to this block, its nearest heading, or the file's " +
            "title/description — do not delete the mention (#832 `nao_apagar_historia`).",
        );
      }
    });
  }
  assert.ok(mentions >= 1, "no memory doc mentions `core/vps` any more — this pins the issue's literal grep, not just the general scan");
  assert.ok(
    markedMentions >= 1,
    "no `core/vps` mention in memory is marked historical — history was deleted rather than marked (#832 `nao_apagar_historia`)",
  );
});

test("#ac-X.2 the scan derives its shells from disk — no shell name is written into the derivation", () => {
  assert.doesNotMatch(
    deriveShellMemoryDirs.toString(),
    /claude-code|opencode/,
    "the derivation must not name a shell — core/opencode/memory/ must enter the scan by existing, not by being listed",
  );
  for (const entry of readdirSync(CORE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // false for the legacy core/memory symlink — must stay skipped
    const dir = path.join(CORE, entry.name, "memory");
    if (existsSync(dir)) {
      assert.ok(shellMemoryDirs.includes(dir), `${dir} exists on disk but the derived scan skips it`);
    }
  }
  assert.ok(shellMemoryDirs.length >= 1, "no core/<shell>/memory found — the scan would pass vacuously");
});
