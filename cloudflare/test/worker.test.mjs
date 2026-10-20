import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import worker from '../src/worker.mjs';
function wordFile(){
 const name=Buffer.from('word/document.xml'),raw=Buffer.from('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>可以測試D1</w:t></w:r></w:p></w:body></w:document>'),deflated=deflateRawSync(raw);
 const loc=Buffer.alloc(30);loc.writeUInt32LE(0x04034b50);loc.writeUInt16LE(8,8);loc.writeUInt32LE(deflated.length,18);loc.writeUInt32LE(raw.length,22);loc.writeUInt16LE(name.length,26);
 const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(8,10);cd.writeUInt32LE(deflated.length,20);cd.writeUInt32LE(raw.length,24);cd.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(cd.length+name.length,12);end.writeUInt32LE(loc.length+name.length+deflated.length,16);
 return Buffer.concat([loc,name,deflated,cd,name,end]);
}
const token='x'.repeat(48);
const env={DB:{},OWNER_TOKEN:token};
const req=(route,headers={})=>new Request(`https://example.workers.dev${route}`,{headers});
test('未授權存取遭拒絕',async()=>{const r=await worker.fetch(req('/api/health'),env);assert.equal(r.status,401);});
test('未配置安全密鑰時不開放',async()=>{const r=await worker.fetch(req('/api/health',{Authorization:'Bearer weak'}),{DB:{},OWNER_TOKEN:'weak'});assert.equal(r.status,503);});
test('已授權健康檢查',async()=>{const r=await worker.fetch(req('/api/health',{Authorization:`Bearer ${token}`}),env);assert.equal(r.status,200);assert.equal((await r.json()).storage,'D1');});
test('拒絕惡意跨來源請求',async()=>{const r=await worker.fetch(req('/api/health',{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}),env);assert.equal(r.status,403);});
test('建立 Word 任務僅持久化擷取文字，不儲存原檔位元組',async()=>{
 let bindParams;
 const db={prepare(sql){assert.match(sql,/INSERT INTO tasks/);return {bind(...args){bindParams=args;return {run:async()=>({success:true})};}}}};
 const f=new FormData();f.append('title','文字提案');f.append('instruction','請提出修正建議');f.append('document',new Blob([wordFile()],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'demo.docx');
 const r=await worker.fetch(new Request('https://example.workers.dev/api/tasks',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:f}),{DB:db,OWNER_TOKEN:token});
 assert.equal(r.status,201);const body=await r.json();assert.equal(body.extracted_characters,6);
 assert.equal(bindParams[2],'請提出修正建議');assert.equal(bindParams[3],'可以測試D1');assert.equal(bindParams[4],'demo.docx');assert.ok(bindParams.every(x=>typeof x==='string'));
});
