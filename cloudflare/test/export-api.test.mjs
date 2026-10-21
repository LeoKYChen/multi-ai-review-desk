import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
const taskId='11111111-1111-4111-8111-111111111111';
const token='x'.repeat(48);
const db={prepare(sql){
 if(sql.startsWith('SELECT * FROM tasks WHERE id='))return{bind(){return{first:async()=>({
  id:taskId,title:'檢查案',instruction:'請給建議',document_text:'原文保留',document_name:'source.docx',
  mode:'manual',status:'closed',created_at:'2026-10-20'
 })};}};
 if(sql.startsWith('SELECT * FROM task_rounds'))return{bind(){return{all:async()=>({results:[{id:'round1',ordinal:1,state:'closed',created_at:'2026-10-20'}]})};}};
 if(sql.includes('FROM ai_outputs WHERE round_id='))return{bind(){return{all:async()=>({results:[{provider:'gemini',phase:'proposal',body:'修正 B',created_at:'2026-10-20T12:10Z',source:'manual_unverified'}]})};}};
 if(sql.startsWith('SELECT decision,note,created_at'))return{bind(){return{first:async()=>({decision:'accept_gemini',note:'採納二',created_at:'2026-10-20T12:12Z'})};}};
 throw Error(sql);
}};
const env={DB:db,OWNER_TOKEN:token};
test('只有登入使用者可以取得完整 Markdown 匯出',async()=>{
 const no=await worker.fetch(new Request('https://example.workers.dev/api/tasks/'+taskId+'/export.md'),env);
 assert.equal(no.status,401);
 const yes=await worker.fetch(new Request('https://example.workers.dev/api/tasks/'+taskId+'/export.md',{headers:{Authorization:'Bearer '+token}}),env);
 assert.equal(yes.status,200);
 assert.match(yes.headers.get('content-type'),/text\/markdown/);
 assert.match(yes.headers.get('content-disposition'),/attachment/);
 const text=await yes.text();
 for(const item of ['原文保留','修正 B','採納二','來源未驗證'])assert.match(text,new RegExp(item));
});
test('退回重議必須有具體說明',async()=>{
 const req=new Request('https://example.workers.dev/api/tasks/'+taskId+'/review',{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({decision:'rework',note:'   '})
 });
 // This fake DB returns closed; the handler stops on the required-feedback check before checking status.
 const res=await worker.fetch(req,env);assert.equal(res.status,422);
 assert.match((await res.json()).error,/退回/);
});
