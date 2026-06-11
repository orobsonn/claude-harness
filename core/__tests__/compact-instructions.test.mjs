/** @description Tests for Compact instructions section in core/CLAUDE.md */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const claudeMdPath = join(__dirname, "..", "CLAUDE.md");

test("Compact instructions section exists and contains all required keywords", () => {
  const content = readFileSync(claudeMdPath, "utf-8");

  // Check that the heading exists
  assert.match(
    content,
    /#\s+Compact instructions/,
    "core/CLAUDE.md must contain '# Compact instructions' heading"
  );

  // Extract the section after "# Compact instructions" until the next heading
  const sectionMatch = content.match(
    /#\s+Compact instructions\n([\s\S]*?)(?=\n#|\z)/
  );
  assert(sectionMatch && sectionMatch[1], "Compact instructions section not found");

  const sectionText = sectionMatch[1];

  // Verify all four required keywords are present in the section
  assert.match(
    sectionText,
    /phase/i,
    "Compact instructions section must mention 'phase'"
  );
  assert.match(
    sectionText,
    /mode/i,
    "Compact instructions section must mention 'mode'"
  );
  assert.match(
    sectionText,
    /plan path/i,
    "Compact instructions section must mention 'plan path'"
  );
  assert.match(
    sectionText,
    /gate state/i,
    "Compact instructions section must mention 'gate state'"
  );
});
