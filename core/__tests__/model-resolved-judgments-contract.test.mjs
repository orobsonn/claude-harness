/**
 * @description Contract tests for `resolved_judgments_model_resolved` (#559) on the OpenCode lane:
 * the planner declares the field in the task shape AND in its self-check (optional, array of
 * resolved_judgments keys), and the shipper consumes it into a dedicated PR-body section that is
 * omitted when nothing is marked. Prose contracts — the field is otherwise a marker nobody reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIELD = "resolved_judgments_model_resolved";

/**
 * @description Read an OpenCode agent definition.
 * @param {string} name agent file basename without extension
 * @returns {string} raw markdown
 */
function readOcAgent(name) {
  return readFileSync(resolve(__dirname, "../opencode/agents", `${name}.md`), "utf8");
}

test("#ac-2.1 planner.md declares the field in the task shape, optional and typed as resolved_judgments keys", () => {
  const planner = readOcAgent("planner");

  const shapeMatch = planner.match(/### Task\n[\s\S]*?(?=\n### LockedTest)/);
  assert.ok(shapeMatch !== null, "planner.md must have a Task shape section");
  const shape = shapeMatch[0];

  assert.ok(shape.includes(FIELD), `the Task shape section must declare ${FIELD}`);
  assert.match(
    shape,
    new RegExp(`${FIELD}[\\s\\S]{0,600}(OPTIONAL|optional)`),
    `the Task shape section must declare ${FIELD} as optional`
  );
  assert.match(
    shape,
    new RegExp(`${FIELD}[\\s\\S]{0,600}array of strings`),
    `the Task shape section must state ${FIELD} is an array of strings`
  );
  assert.match(
    shape,
    new RegExp(`${FIELD}[\\s\\S]{0,600}key of the \\*\\*same task's\\*\\* \`resolved_judgments\``),
    `the Task shape section must state each entry is a key of the same task's resolved_judgments`
  );
});

test("#ac-2.1 planner.md self-check covers the field, optional and keyed to the same task's resolved_judgments", () => {
  const planner = readOcAgent("planner");

  const selfCheckMatch = planner.match(/## 5\. Self-check[\s\S]*?(?=\n## 6\.)/);
  assert.ok(selfCheckMatch !== null, "planner.md must have a Self-check section");
  const selfCheck = selfCheckMatch[0];

  assert.ok(selfCheck.includes(FIELD), `the self-check must name ${FIELD}`);
  assert.match(selfCheck, /optional/i, "the self-check must declare the field optional");
  assert.match(
    selfCheck,
    new RegExp(`${FIELD}[\\s\\S]{0,400}array of strings`),
    "the self-check must state the format (array of strings)"
  );
  assert.match(
    selfCheck,
    new RegExp(`${FIELD}[\\s\\S]{0,400}SAME task's \`resolved_judgments\``),
    "the self-check must tie every entry to the same task's resolved_judgments"
  );
});

test("#ac-3.1 shipper.md builds a PR-body section from the marked keys and their values", () => {
  const shipper = readOcAgent("shipper");

  assert.ok(shipper.includes(FIELD), `shipper.md must read ${FIELD}`);

  const sectionHeading = "## Decisions the engine made on its own";
  assert.ok(
    shipper.includes(sectionHeading),
    `shipper.md must name the PR-body section heading (${sectionHeading})`
  );

  // The section is built from key + value, in product language — all of it stated in the
  // step that reads the marker, so the instruction cannot drift away from its trigger.
  const start = shipper.indexOf(FIELD);
  const consumption = shipper.slice(start, start + 3000);
  assert.ok(
    consumption.includes(sectionHeading),
    "shipper.md must co-locate reading the marked keys with emitting the PR-body section"
  );
  assert.match(
    consumption,
    /value from that task's `resolved_judgments`/,
    "shipper.md must instruct pairing each marked key with its value"
  );
  assert.match(
    consumption,
    /product language/i,
    "shipper.md must require product language in the section"
  );
});

test("#ac-3.1 shipper.md omits the section entirely when no task marks a key", () => {
  const shipper = readOcAgent("shipper");

  assert.match(
    shipper,
    /(empty or absent|no task lists a model-resolved key)[\s\S]{0,300}(no section|omit this whole section)/i,
    "shipper.md must state that an empty/absent marker array emits no section at all"
  );
  assert.match(
    shipper,
    /Never an empty section, never an "n\/a" placeholder\./,
    "shipper.md must forbid an empty/placeholder section"
  );
});
