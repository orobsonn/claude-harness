import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { parseShardOptions, runVitestShards } from "./vitest-shards.mjs";

function fixture(t, body) {
  const cwd = mkdtempSync(path.join(tmpdir(), "vitest-shards-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, "node_modules/vitest");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "vitest.mjs"), body);
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  return { cwd, worker: path.join(directory, "vitest.mjs"), stdout: sink, stderr: sink, text: () => output };
}

test("all numbered shards start concurrently and success waits for every shard", async (t) => {
  const f = fixture(t, `import fs from 'node:fs';
    const shard=process.argv.at(-1); fs.writeFileSync(shard.replace('/','-'), 'started');
    const deadline=Date.now()+3000;
    while(!['--shard=1-2','--shard=2-2'].every(n=>fs.existsSync(n))) {
      if(Date.now()>deadline) process.exit(9);
      await new Promise(r=>setTimeout(r,10));
    }
    await new Promise(r=>setTimeout(r,shard.includes('2/2')?150:10));
    console.log(shard+' complete');`);
  assert.equal(await runVitestShards({ ...f, shards: 2, timeoutSeconds: 10 }), 0);
  assert.match(f.text(), /--shard=1\/2 complete/);
  assert.match(f.text(), /--shard=2\/2 complete/);
  assert.match(f.text(), /PASS: 2\/2/);
});

test("a failing shard cancels a hanging sibling and cannot pass", async (t) => {
  const f = fixture(t, `if(process.argv.at(-1).includes('1/2')) {
      setTimeout(()=>process.exit(7),100);
    } else { setInterval(()=>{},1000); }`);
  assert.equal(await runVitestShards({ ...f, shards: 2, timeoutSeconds: 10 }), 1);
  assert.match(f.text(), /Shard 1\/2 failed/);
  assert.match(f.text(), /FAIL/);
});

test("a failure event cancels shards even while the failing process keeps traversing hooks", async (t) => {
  const f = fixture(t, `if(process.argv.at(-1).includes('1/2')) {
      setTimeout(()=>process.send({type:'harness-vitest-failure',identity:'test/matrix.spec.ts > matrix > case'}),50);
    }
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);`);
  assert.equal(await runVitestShards({ ...f, shards: 2, timeoutSeconds: 10 }), 1);
  assert.match(f.text(), /reported a failed test/);
  assert.match(f.text(), /test\/matrix.spec.ts > matrix > case/);
  assert.match(f.text(), /FAIL: 0\/2 shards passed/);
  assert.doesNotMatch(f.text(), /Timeout/);
});

test("timeout fails and terminates a workerd-like descendant", async (t) => {
  const f = fixture(t, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync('descendant.pid',String(child.pid)); setInterval(()=>{},1000);`);
  assert.equal(await runVitestShards({ ...f, shards: 1, timeoutSeconds: 1 }), 1);
  const pid = Number(readFileSync(path.join(f.cwd, "descendant.pid")));
  // /proc can briefly retain a killed orphan as a zombie until init reaps it.
  let alive = true;
  const deadline = Date.now() + 2000;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) alive = false;
    } catch { alive = false; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, "descendant must terminate after receiving SIGKILL");
  assert.match(f.text(), /Timeout/);
});

test("focused npm arguments use one process and forward the exact filters", async (t) => {
  const f = fixture(t, "console.log(JSON.stringify(process.argv.slice(2)));");
  const parsed = parseShardOptions(["--shards", "4", "--", "src/example.spec.ts", "-t", "case with spaces"]);
  assert.equal(parsed.shards, 1);
  assert.equal(await runVitestShards({ ...f, ...parsed }), 0);
  assert.match(f.text(), /\["run","src\/example.spec.ts","-t","case with spaces"\]/);
});

test("focused native CLI does not inherit an IPC channel that listeners keep alive", async (t) => {
  const f = fixture(t, "process.on('message',()=>{}); console.log('ipc='+Boolean(process.connected));");
  assert.equal(await runVitestShards({ ...f, shards: 1, timeoutSeconds: 2, args: ['src/example.spec.ts'] }), 0);
  assert.match(f.text(), /ipc=false/);
  assert.doesNotMatch(f.text(), /Timeout/);
});

test("invalid counts and user sharding/watch overrides are rejected", () => {
  for (const value of ["0", "33", "2.5", "", "abc"]) {
    assert.throws(() => parseShardOptions(["--shards", value]), /integer/);
  }
  assert.throws(() => parseShardOptions(["--shards"]), /integer/);
  assert.throws(() => parseShardOptions(["--timeout-seconds", "0"]), /Timeout/);
  for (const flag of ["--shard=1/4", "--watch", "--passWithNoTests"]) {
    assert.throws(() => parseShardOptions(["--", flag]), /owns sharding/);
  }
  assert.deepEqual(parseShardOptions([], { HARNESS_TEST_SHARDS: "4" }), {
    shards: 4, timeoutSeconds: 3600, args: [],
  });
});

test("CLI interruption reports failure and cleans up descendants", async (t) => {
  const f = fixture(t, "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "vitest-shards.mjs"), "--shards", "1"], {
    cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  let output = "";
  let sent = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!sent && output.includes("ready")) { sent = true; child.kill("SIGTERM"); }
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.match(output, /Interrupted/);
  assert.match(output, /FAIL/);
  assert.match(output, /0\/1 shards passed/);
});
