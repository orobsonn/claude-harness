import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProviderControlConfig, providerTaskTimeoutMs } from "./provider-control-config.mjs";
test("host settings retain two slots and legacy enable/disable; Verboo alone gets six hours",t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'provider-limits-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const dir=path.join(home,'.config/claude-harness');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'provider-request-control.json');
 assert.equal(readProviderControlConfig(home).maxConcurrent,2);
 assert.equal(providerTaskTimeoutMs('verboo',home),21_600_000);assert.equal(providerTaskTimeoutMs('ollama-cloud',home),7_200_000);
 for(const enabled of [true,false]){fs.writeFileSync(file,JSON.stringify({verboo:enabled}));assert.equal(readProviderControlConfig(home).enabled,enabled);}
 fs.writeFileSync(file,JSON.stringify({verboo:{maxConcurrent:4,taskTimeoutMs:14_400_000}}));
 assert.equal(readProviderControlConfig(home).maxConcurrent,4);assert.equal(providerTaskTimeoutMs('verboo',home),14_400_000);
 for(const verboo of [{maxConcurrent:0},{maxConcurrent:7},{maxConcurrent:4.5},{taskTimeoutMs:0},{taskTimeoutMs:86_400_001},{enabled:'true'},null]){
  fs.writeFileSync(file,JSON.stringify({verboo}));assert.throws(()=>readProviderControlConfig(home));
 }
 fs.writeFileSync(file,'{');assert.throws(()=>readProviderControlConfig(home));
 for(const config of [null,[],2]){fs.writeFileSync(file,JSON.stringify(config));assert.throws(()=>readProviderControlConfig(home));}
});
