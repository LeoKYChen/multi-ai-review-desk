import test from 'node:test';
import assert from 'node:assert/strict';
import {hasHumanAuth,login,logoutHeaders} from '../src/session.mjs';
const env={OWNER_PASSWORD:'my-long-sample-password-very-secret',OWNER_TOKEN:'a'.repeat(60)};
const url='https://example.workers.dev/api/login';
const request=p=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
test('登入後取得安全 HttpOnly Cookie，無密碼返回',async()=>{
 const res=await login(request(env.OWNER_PASSWORD),env);const c=res.headers['Set-Cookie'];assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.match(c,/Secure/);assert.doesNotMatch(c,/my-long-sample-password/);
 const authReq=new Request('https://example.workers.dev/api/tasks',{headers:{Cookie:c.split(';')[0]}});
 assert.equal(await hasHumanAuth(authReq,env),true);
});
test('錯誤密碼與 null 不會登入',async()=>{
 await assert.rejects(()=>login(request('wrong'),env),/密碼錯誤/);
 await assert.rejects(()=>login(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'null'}),env),/密碼錯誤/);
});
test('偽造 Cookie 不可登入',async()=>{
 const req=new Request('https://example.workers.dev/api/tasks',{headers:{Cookie:'ma_session=12345.'+'b'.repeat(64)}});
 assert.equal(await hasHumanAuth(req,env),false);
});
test('登出使 Cookie 失效',()=>assert.match(logoutHeaders()['Set-Cookie'],/Max-Age=0/));
