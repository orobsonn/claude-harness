import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSource, stripComments, looksBinary } from "./complexity-scorer.mjs";

test("band boundaries: trivial file becomes low", () => {
  const r = analyzeSource("src/util.ts", "export const x = 1;\n");
  assert.equal(r.complexity, "low");
  assert.equal(r.should_split, false);
});

test("recalibration: pure composition file (13 local imports, zero logic) lands LOW", () => {
  const src = Array.from({ length: 13 }, (_, i) => `import m${i} from "./m${i}";`).join("\n") + "\nexport default {};\n";
  const r = analyzeSource("src/index.ts", src);
  assert.equal(r.complexity, "low");
  assert.ok(r.breakdown.imports.score <= 6, "imports capped at 6");
  assert.ok(r.breakdown["local-deps"].score <= 4, "local-deps capped at 4");
});

test("recalibration: async is NOT double-charged, only await counts", () => {
  const src = "async function f() { await g(); await h(); }\nasync function p() {}\n";
  const r = analyzeSource("src/x.ts", src);
  assert.equal(r.metrics.async_count, 2, "two awaits, async keyword ignored");
});

test("recalibration: else/case/default are NOT branches; switch counts once", () => {
  const src = "function f(x){ if(x){} else {} switch(x){ case 1: break; default: break; } }\n";
  const r = analyzeSource("src/x.ts", src);
  assert.equal(r.metrics.branch_count, 2);
});

test("recalibration: shared-dir anchored to segments, libraries does NOT match", () => {
  const inShared = analyzeSource("src/lib/x.ts", "export const x=1;\n");
  const inLibraries = analyzeSource("src/libraries/x.ts", "export const x=1;\n");
  assert.ok(inShared.breakdown["shared-location"], "lib matches shared");
  assert.ok(inLibraries.breakdown["isolated-location"], "libraries does NOT match shared");
});

test("recalibration: import type excluded from import count", () => {
  const src = 'import type { T } from "./t";\nimport x from "./x";\n';
  const r = analyzeSource("src/x.ts", src);
  assert.equal(r.metrics.import_count, 1, "only the runtime import counts");
});

test("service families collapse: env and process.env count as ONE family", () => {
  const src = "const a = env.FOO; const b = process.env.BAR;\n";
  const r = analyzeSource("src/x.ts", src);
  assert.equal(r.metrics.service_family_count, 1);
});

test("loops counted at weight 2", () => {
  const src = "function f(){ for(;;){} while(true){} }\n";
  const r = analyzeSource("src/x.ts", src);
  assert.equal(r.metrics.loop_count, 2);
  assert.equal(r.breakdown.loops.score, 4);
});

test("should_split fires on large file regardless of band", () => {
  const big = "const a = 1;\n".repeat(420);
  const r = analyzeSource("src/big.ts", big);
  assert.equal(r.should_split, true);
  assert.match(r.split_hint, /code lines/);
});

test("4-band contract: no max band ever returned", () => {
  for (const n of [0, 50, 200, 500, 2000]) {
    const src = "if(x){}\n".repeat(n);
    const band = analyzeSource("src/x.ts", src).complexity;
    assert.ok(["low", "medium", "high", "x-high"].includes(band), `band ${band} within contract`);
  }
});

test("stripComments removes line and block comments preserving newlines", () => {
  const out = stripComments("a // c\n/* b\nb */\nx", true);
  assert.equal(out.split("\n").length, 4);
});

test("looksBinary detects a NUL byte", () => {
  const withNul = "x" + String.fromCharCode(0) + "y";
  assert.equal(looksBinary(withNul), true);
  assert.equal(looksBinary("plain text"), false);
});
