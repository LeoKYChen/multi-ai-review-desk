import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/verify-staging-db.mjs',import.meta.url));
const stagId='11111111-1111-4111-8111-111111111111';
function check(rows,expectOk,env={}){
 const base=mkdtempSync(join(tmpdir(),'fd-verify-db-'));
 try{
  const path=join(base,'list.json');writeFileSync(path,JSON.stringify(rows),'utf8');
  const result=spawnSync(process.execPath,[script,path],{encoding:'utf8',
   env:{...process.env,CF_STAGING_D1_DATABASE_ID:stagId,CF_D1_DATABASE_ID:'22222222-2222-4222-8222-222222222222',...env}});
  if(expectOk)assert.equal(result.status,0,result.stderr);
  else assert.notEqual(result.status,0,'unsafe staging target was accepted');
  return result;
 }finally{rmSync(base,{recursive:true,force:true});}
}
test('Cloudflare 遠端清單 staging 名稱＋UUID 正確時才可用',()=>{
 const r=check([{name:'multi-ai-review-desk-staging-db',uuid:stagId},
  {name:'multi-ai-review-desk-db',uuid:'22222222-2222-4222-8222-222222222222'}],true);
 assert.match(r.stdout,/PASS/);
});
test('名稱相同但 UUID 不同，禁止執行遠端遷移',()=>{
 check([{name:'multi-ai-review-desk-staging-db',uuid:'99999999-9999-4999-8999-999999999999'}],false);
});
test('staging UUID 與既有 D1 相同，禁止執行遠端遷移',()=>{
 check([{name:'multi-ai-review-desk-staging-db',uuid:stagId}],false,{CF_D1_DATABASE_ID:stagId});
});
test('沒有獨立 staging DB、Cloudflare 清單格式錯誤均拒絕',()=>{
 check([{name:'multi-ai-review-desk-db',uuid:stagId}],false);
 check({message:'unexpected'},false);
});
