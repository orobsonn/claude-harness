/** Exercise the actual CLI adapters with subprocesses, not pre-parsed gh objects. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const selector=fileURLToPath(new URL('./select-and-dispatch.mjs',import.meta.url));
const merged=JSON.parse(fs.readFileSync(new URL('./__fixtures__/merged-dependency-pr.json',import.meta.url),'utf8'));
for(const [name,payload,eligible]of [
  ['merged PR',JSON.stringify(merged),true],
  ['closed issue',JSON.stringify({number:401,state:'closed'}),true],
  ['closed unmerged PR',JSON.stringify({...merged,pull_request:{...merged.pull_request,merged_at:null}}),false],
  ['malformed API JSON','{invalid-json',false],
]){
  test(`real selector CLI parses gh api stdout: ${name}`,()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'orca-dependency-cli-'));
    try{
      const trace=path.join(root,'trace');fs.writeFileSync(trace,'');
      const script=(name,code)=>{const file=path.join(root,name+'.mjs');fs.writeFileSync(file,'#!'+process.execPath+'\n'+code,{mode:0o755});return file;};
      const orca=script('orca',`const a=process.argv.slice(2);if(a[0]!=='worktree'||a[1]!=='ps')throw Error('unexpected Orca mutation');console.log(JSON.stringify({ok:true,result:{worktrees:[],totalCount:0,truncated:false}}));`);
      const candidate={number:403,title:'Dependent delivery',createdAt:'2026-10-25T00:00:00Z',body:'\u0060\u0060\u0060harness-deps\n#401\n\u0060\u0060\u0060',labels:[],blockedBy:{nodes:[],totalCount:0}};
      const gh=script('gh',`const a=process.argv.slice(2);if(a[0]==='api'){if(a[1]!=='repos/example/repo/issues/401')throw Error('wrong dependency');process.stdout.write(${JSON.stringify(payload)});}else if(a[0]==='issue'&&a[1]==='list'){console.log(JSON.stringify(a[a.indexOf('--label')+1]==='harness:in-progress'?[]:[${JSON.stringify(candidate)}]));}else throw Error('unexpected gh mutation');`);
      // This intentional barrier proves eligibility without even a simulated label claim.
      const git=script('git',`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(trace)},'fetch reached\\n');process.exit(9);`);
      const config=path.join(root,'project.json');fs.writeFileSync(config,JSON.stringify({project:'fixture',ghRepo:'example/repo',orcaRepoId:'repo-fixture',clonePath:root,globalMaxWorking:4,agent:'pi'}));
      const run=spawnSync(process.execPath,[selector,'--config',config],{encoding:'utf8',timeout:15000,env:{...process.env,ORCA_BIN:orca,GH_BIN:gh,GIT_BIN:git}});
      assert.equal(run.error,undefined);
      assert.equal(run.status,eligible?1:0,run.stdout+run.stderr);
      assert.equal(fs.readFileSync(trace,'utf8').includes('fetch reached'),eligible,run.stdout+run.stderr);
      assert.match(run.stdout,eligible?/could not fetch/:/waiting on open dependencies/);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
}
