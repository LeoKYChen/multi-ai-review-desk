import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const script=join(root,'scripts','prepare-staging.mjs');
test('缺少 Cloudflare 資料庫設定時拒絕部署',()=>{
 const p=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'',CF_D1_DATABASE_ID:''}});
 assert.notEqual(p.status,0);
 assert.match((p.stderr||'')+(p.stdout||''),/CF_D1_DATABASE_ID/);
});
test('錯誤 D1 UUID 時拒絕產生 Wrangler 配置',()=>{
 const p=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CF_D1_DATABASE_ID:'not-a-valid-database-id'}});
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/CF_D1_DATABASE_ID/);
});
