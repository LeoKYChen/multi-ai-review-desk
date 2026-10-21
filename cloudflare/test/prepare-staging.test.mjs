import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const script=join(root,'scripts','prepare-staging.mjs');
test('缺少 Cloudflare 資料庫設定時拒絕部署',()=>{
 const p=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'',CF_STAGING_D1_DATABASE_ID:''}});
 assert.notEqual(p.status,0);
 assert.match((p.stderr||'')+(p.stdout||''),/CF_STAGING_D1_DATABASE_ID/);
});
test('錯誤 D1 UUID 時拒絕產生 Wrangler 配置',()=>{
 const p=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CF_STAGING_D1_DATABASE_ID:'not-a-valid-database-id'}});
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/CF_STAGING_D1_DATABASE_ID/);
});


test('封閉 staging 設定使用不同 D1，停用公開 workers.dev、preview 與所有模型 API',()=>{


 const scratch=mkdtempSync(join(tmpdir(),'feedback-staging-'));
 try{
  const cf=join(scratch,'cloudflare');mkdirSync(join(cf,'scripts'),{recursive:true});
  copyFileSync(script,join(cf,'scripts','prepare-staging.mjs'));
  copyFileSync(join(root,'wrangler.toml.example'),join(cf,'wrangler.toml.example'));
  const testEnv={...process.env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
   CF_STAGING_D1_DATABASE_ID:'11111111-1111-4111-8111-111111111111',
   CF_D1_DATABASE_ID:'22222222-2222-4222-8222-222222222222',
   STAGING_NETWORK_MODE:'closed'};
  const p=spawnSync(process.execPath,[join(cf,'scripts','prepare-staging.mjs')],{
   cwd:cf,env:testEnv,encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);
  const config=readFileSync(join(cf,'wrangler.toml'),'utf8');
  for(const s of ['workers_dev = false','preview_urls = false',
   'database_name = "multi-ai-review-desk-staging-db"',
   'MODEL_API_ENABLED = "false"','BACKGROUND_JOBS_ENABLED = "false"'])assert.ok(config.includes(s),s);
  assert.ok(!config.includes('database_name = "multi-ai-review-desk-db"'));
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
test('Access 未確認不能啟用 workers.dev',()=>{


 const scratch=mkdtempSync(join(tmpdir(),'feedback-staging-'));
 try{
  const cf=join(scratch,'cloudflare');mkdirSync(join(cf,'scripts'),{recursive:true});
  copyFileSync(script,join(cf,'scripts','prepare-staging.mjs'));
  copyFileSync(join(root,'wrangler.toml.example'),join(cf,'wrangler.toml.example'));
  const p=spawnSync(process.execPath,[join(cf,'scripts','prepare-staging.mjs')],{
   cwd:cf,encoding:'utf8',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
    CF_STAGING_D1_DATABASE_ID:'11111111-1111-4111-8111-111111111111',
    STAGING_NETWORK_MODE:'access-protected',STAGING_ACCESS_CONFIRMED:'false'}});
  assert.notEqual(p.status,0);assert.match(p.stderr,/Access/);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
