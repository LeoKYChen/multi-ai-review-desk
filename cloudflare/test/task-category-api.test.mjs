import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
const token='s'.repeat(48),host='https://example.workers.dev';
function get(path,db){return worker.fetch(new Request(host+path,{headers:{Authorization:'Bearer '+token}}),{OWNER_TOKEN:token,DB:db});}
test('D1 列表可安全地組合查詢分類與狀態',async()=>{
 let statement='',values;
 const db={prepare(sql){statement=sql;return{bind(...xs){values=xs;return{all:async()=>({results:[{id:'x',title:'我的任務',category:'文件審查'}]})};}}}};
 const resp=await get('/api/tasks?q=%E6%B3%95%E5%BE%8B&status=running&category=%E6%96%87%E4%BB%B6%E5%AF%A9%E6%9F%A5',db);
 assert.equal(resp.status,200);
 assert.match(statement,/status=\?/);assert.match(statement,/category=\?/);
 assert.deepEqual(values,['法律','法律','法律','running','文件審查']);
 assert.equal((await resp.json()).tasks[0].title,'我的任務');
});
test('無效搜尋參數不會讀取資料庫',async()=>{
 const db={prepare(){throw Error('must not touch DB');}};
 const resp=await get('/api/tasks?status=__INVALID__',db);
 assert.equal(resp.status,422);
});
test('建立任務包含分類但不修改原文',async()=>{
 let values=[],statement='';
 const db={prepare(sql){statement=sql;return{bind(...xs){values=xs;return{run:async()=>({success:true})};}}}};
 const form=new FormData();
 form.append('title','試用任務');form.append('instruction','檢視格式');form.append('category','研究分析');form.append('mode','manual');
 const resp=await worker.fetch(new Request(host+'/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+token},body:form}),{OWNER_TOKEN:token,DB:db});
 assert.equal(resp.status,201);
 assert.match(statement,/category/);assert.equal(values[values.length-1],'研究分析');
 assert.equal(values[2],'檢視格式');
 assert.equal((await resp.json()).category,'研究分析');
});
test('分類長度超限遭拒絕',async()=>{
 const form=new FormData();
 form.append('title','測試');form.append('instruction','測試');form.append('category','Z'.repeat(31));
 const resp=await worker.fetch(new Request(host+'/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+token},body:form}),{OWNER_TOKEN:token,DB:{}});
 assert.equal(resp.status,422);
});
