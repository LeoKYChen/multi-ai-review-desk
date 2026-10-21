import test from 'node:test';
import assert from 'node:assert/strict';
import {apiEnabled,modelCallCaps,guardedLogin,checkLoginThrottle,registerLoginFailure} from '../src/guardrails.mjs';
test('API 模式預設停用，需要明確啟用',()=>{
 assert.equal(apiEnabled({}),false);assert.equal(apiEnabled({MODEL_API_ENABLED:'false'}),false);
 assert.equal(apiEnabled({MODEL_API_ENABLED:'true'}),true);
});
test('每任務與每日 API 上限皆有保守預設，拒絕不合理設定',()=>{
 assert.deepEqual(modelCallCaps({}),{perTask:12,perDay:12});
 assert.deepEqual(modelCallCaps({MODEL_MAX_CALLS_PER_TASK:'2',MODEL_MAX_CALLS_PER_DAY:'3'}),{perTask:2,perDay:3});
 assert.deepEqual(modelCallCaps({MODEL_MAX_CALLS_PER_TASK:'10000',MODEL_MAX_CALLS_PER_DAY:'-1'}),{perTask:12,perDay:12});
});
test('來源 IP 不以原文直接儲存至查詢鍵',async()=>{
 const request=new Request('https://test.invalid/api/login',{headers:{'CF-Connecting-IP':'203.0.113.17'}});
 const env={OWNER_TOKEN:'a'.repeat(48),DB:{prepare(query){assert.match(query,/SELECT failures/);return{bind(hash){assert.match(hash,/^[0-9a-f]{64}$/);assert.ok(!hash.includes('203.0.113.17'));return{first:async()=>null};}}}}};
 const result=await checkLoginThrottle(request,env);assert.equal(result.hash.length,64);
});
test('錯誤密碼會記錄失敗，沒有取得 Cookie',async()=>{
 let bound=0;
 const request=new Request('https://test.invalid/api/login');
 const env={OWNER_TOKEN:'a'.repeat(48),DB:{prepare(sql){return{bind(...args){bound++;if(sql.includes('SELECT failures'))return{first:async()=>null};
  if(sql.includes('INSERT INTO login_rate_limits'))return{run:async()=>({meta:{changes:1}})};
  throw Error(sql);}};}}};
 await assert.rejects(()=>guardedLogin(request,env,async()=>{throw Object.assign(new Error('wrong'),{status:401});}),/wrong/);
 assert.equal(bound,2);
});
test('成功登入會清除該訪客的失敗紀錄',async()=>{
 let removed=false;const request=new Request('https://test.invalid/api/login');
 const env={OWNER_TOKEN:'a'.repeat(48),DB:{prepare(sql){return{bind(){if(sql.startsWith('SELECT'))return{first:async()=>null};if(sql.startsWith('DELETE'))return{run:async()=>{removed=true;}};throw Error(sql);}};}}};
 const result=await guardedLogin(request,env,async()=>({data:{authenticated:true}}));
 assert.equal(result.data.authenticated,true);assert.equal(removed,true);
});
