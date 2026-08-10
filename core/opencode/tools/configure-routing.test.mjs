/** @description Locks the host-owned confirmation in the native routing tool (#446). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./configure-routing.ts", import.meta.url), "utf8");

test("routing apply requests explicit host confirmation while inspect stays read-only", () => {
  assert.match(source, /if \(action === "apply"\)[\s\S]*await context\.ask\(/);
  assert.match(source, /permission:\s*"configure-routing"/);
  assert.match(source, /patterns:\s*\["apply"\]/);
});
