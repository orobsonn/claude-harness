import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verificationInvocation } from "./pi-verify.mjs";
import { decidePiPolicy } from "../lib/policy.mjs";

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pi-focal-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const f of ["test/a.test.ts","test/node/b.test.ts","vitest.config.node.ts","node_modules/vitest/vitest.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),"");
  }
  return root;
}
test("focal runner filters the installed Vitest without executing chained npm scripts",t=>{
  const root=fixture(t);
  fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({scripts:{"test:pool":"touch should-not-run && vitest run"}}));
  fs.writeFileSync(path.join(root,"node_modules/vitest/vitest.mjs"),"console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);");
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./pi-verify.mjs',import.meta.url)),"--pool","test/a.test.ts"],{cwd:root,encoding:"utf8"});
  assert.equal(result.status,7);assert.deepEqual(JSON.parse(result.stdout),["run","test/a.test.ts"]);
  assert.equal(fs.existsSync(path.join(root,"should-not-run")),false);
  assert.deepEqual(verificationInvocation(["--node","test/node/b.test.ts"],root).args.slice(1),["run","--config","vitest.config.node.ts","test/node/b.test.ts"]);
});
test("focal runner rejects external paths, symlink escapes, lane mismatch and runner flags",t=>{
  const root=fixture(t);const outside=fs.mkdtempSync(path.join(os.tmpdir(),'focal-out-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,"escape.test.ts"),"");fs.symlinkSync(path.join(outside,"escape.test.ts"),path.join(root,"test/escape.test.ts"));
  for(const args of [["--pool","../escape.test.ts"],["--pool","test/escape.test.ts"],["--node","test/a.test.ts"],["--pool","test/node/b.test.ts"],["--pool","--config=evil.js"],["--pool"]])assert.throws(()=>verificationInvocation(args,root));
});
test("parent policy allows the literal focal helper during FULL without broadening npx",()=>{
  const options={gateState:{classified:true,mode:"FULL",feature_id:"focal"}};
  assert.equal(decidePiPolicy({toolName:"bash",input:{command:"node .pi/harness/bin/pi-verify.mjs --pool test/a.test.ts"}},options).block,false);
  assert.equal(decidePiPolicy({toolName:"bash",input:{command:"npx arbitrary-package"}},options).block,true);
});
