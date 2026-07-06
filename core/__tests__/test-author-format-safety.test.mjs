#!/usr/bin/env node
// @description Contract tests for test-author agent definition body:
// (1) the step-5 self-check window mentions a formatter/format-conformance
//     concept alongside a final-step self-check marker;
// (2) the body documents the block-comment terminator footgun rule for
//     cron/early-close hazards.
// Tests run under node:test. The hazardous comment-terminator and
// comment-opener token strings used for searching are built as string
// literals only (never written as an actual comment delimiter in this
// file's own comments) to avoid closing this file's comments early.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agentMdPath = resolve(__dirname, "../agents/test-author.md");

// Hazardous tokens kept exclusively as string literals / constructed via
// concatenation so the raw two-character terminator sequence never appears
// literally in this source file.
const BLOCK_COMMENT_OPENER = "/" + "**";
const BLOCK_COMMENT_TERMINATOR = "*" + "/";

/**
 * Parses YAML frontmatter from a markdown file.
 * Returns { frontmatter: object, body: string }.
 */
function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    throw new Error("File must start with --- delimiter");
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("No closing --- delimiter found");
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const fm = {};
  let tools = [];

  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i];
    if (!line.trim()) continue;

    if (line.trim().startsWith("tools:")) {
      for (let j = i + 1; j < frontmatterLines.length; j++) {
        const toolLine = frontmatterLines[j];
        if (toolLine.match(/^\s+-\s+/)) {
          const toolName = toolLine.replace(/^\s+-\s+/, "").trim();
          tools.push(toolName);
        } else if (toolLine.trim() && !toolLine.match(/^\s/)) {
          break;
        } else if (toolLine.trim() && !toolLine.match(/^\s+-/)) {
          break;
        }
      }
    } else {
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      fm[key.trim()] = value;
    }
  }

  fm.tools = tools;
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter: fm, body };
}

/**
 * Isolates the "### 5. Verifique a transcricao" section window from the
 * agent body: from that heading (tolerating the accented
 * "transcrição" spelling) up to the next section boundary — a line that
 * is exactly "---", or the next "## " / "### " heading — whichever comes
 * first. Returns null if the heading is not found.
 */
function extractStep5Window(body) {
  const lines = body.split("\n");
  const headingPattern = /^###\s*5\.\s*Verifique a transcri[cç][aã]o/i;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i].trim())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i];
    if (trimmed === "---" || /^(##\s|###\s)/.test(trimmed)) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Test 1 (#ac-1.1): Given test-author.md, when the step-5 self-check
 * window is isolated, then it MUST mention BOTH a formatter/format-
 * conformance concept AND a final-step/self-check marker, co-located in
 * that window. The bare substring "format" alone (matched by the
 * pre-existing "Formato de resposta" header) must not count, and the
 * search must be scoped to the step-5 window only — a stray "DONE"
 * elsewhere in the body must not satisfy this assertion.
 */
test("test-author.md: step-5 window mentions formatter self-check as the last step", () => {
  const content = readFileSync(agentMdPath, "utf8");
  const { body } = parseFrontmatter(content);

  const window = extractStep5Window(body);
  assert(
    window,
    "step 5 heading ('### 5. Verifique a transcricao' or accented variant) must exist in the body"
  );

  const windowLower = window.toLowerCase();

  const formatterTokens = [
    "formatador",
    "formatação",
    "conformidade de formato",
    "formatter conventions",
  ];
  const hasFormatterConcept = formatterTokens.some((token) =>
    windowLower.includes(token.toLowerCase())
  );
  assert(
    hasFormatterConcept,
    `step 5 window must mention a formatter concept (one of: ${formatterTokens.join(", ")})`
  );

  const selfCheckTokens = [
    "auto-verificação",
    "self-check",
    "último passo",
    "last step",
  ];
  const hasSelfCheckMarker = selfCheckTokens.some((token) =>
    windowLower.includes(token.toLowerCase())
  );
  assert(
    hasSelfCheckMarker,
    `step 5 window must mention a final-step/self-check marker (one of: ${selfCheckTokens.join(", ")})`
  );
});

// Test 2 (#ac-1.2): Given test-author.md, when the full body is searched,
// then it MUST document the block-comment terminator footgun rule: a
// reference to the block-comment form (the opener or the terminator
// sequence) co-occurring with the scheduling-pattern early-close hazard
// mention (the token asserted below, plus a hazard word such as
// fechar/fecha/encerra/close/terminator/terminador).
test("test-author.md: body documents the block-comment terminator cron footgun rule", () => {
  const content = readFileSync(agentMdPath, "utf8");
  const { body } = parseFrontmatter(content);
  const bodyLower = body.toLowerCase();

  const hasBlockCommentReference =
    body.includes(BLOCK_COMMENT_OPENER) || body.includes(BLOCK_COMMENT_TERMINATOR);
  assert(
    hasBlockCommentReference,
    "body must reference the block-comment form (the /** opener or the comment-terminator sequence)"
  );

  const hasCronMention = bodyLower.includes("cron");
  assert(hasCronMention, "body must mention 'cron'");

  const hazardWords = [
    "fechar",
    "fecha",
    "encerra",
    "close",
    "terminator",
    "terminador",
  ];
  const hasHazardWord = hazardWords.some((word) => bodyLower.includes(word));
  assert(
    hasHazardWord,
    `body must mention a hazard word (one of: ${hazardWords.join(", ")})`
  );
});
