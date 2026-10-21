import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getDraft,putDraft,listFinals,getFinal,approveFinal} from '../src/human-finals.mjs';
import worker from '../src/worker.mjs';

const taskId='11111111-1111-4111-8111-111111111111';
const roundId='22222222-2222-4222-8222-222222222222';
function fixture(){
 const d=new DatabaseSync(':memory:');d.exec('PRAGMA foreign_keys=ON');
 const migrations=resolve(dirname(fileURLToPath(import.meta.url)),'../migrations');
 for(const name of readdirSync(migrations).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort())
  d.exec(readFileSync(resolve(migrations,name),'utf8'));
 const DB={prepare(sql){return {bind(...a){const s=d.prepare(sql);return {
  first:async()=>s.get(...a)||null,
  all:async()=>({results:s.all(...a)}),
  run:async()=>({meta:{changes:s.run(...a).changes}})
 };}};},
 async batch(stmts){
  d.exec('BEGIN');try{
   const out=[];for(const s of stmts)out.push(await s.run());
   d.exec('COMMIT');return out;
  }catch(e){d.exec('ROLLBACK');throw e;}
 }};
 d.prepare("INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at,mode) VALUES(?,?,?,'','awaiting_human','t0','t0','manual')")
  .run(taskId,'題目','內容');
 d.prepare("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,1,'awaiting_human','t0')")
  .run(roundId,taskId);
 d.prepare("INSERT INTO source_checks(id,task_id,claim_text,source_label,status,updated_at) VALUES(?,?,?,?,?,'t0')")
  .run('source1',taskId,'法條需要查證','官方來源','pending');
 return {d,env:{DB}};
}

test('草稿原子 CAS：兩裝置同版只有第一個儲存成功，內容未覆寫',async()=>{
 const {env}=fixture();
 assert.equal((await getDraft(env,taskId)).revision,0);
 assert.equal((await putDraft(env,taskId,{expected_revision:0,body:'手機寫入'})).revision,1);
 await assert.rejects(()=>putDraft(env,taskId,{expected_revision:0,body:'電腦舊版'}),e=>{
  assert.equal(e.status,409);assert.equal(e.code,'DRAFT_VERSION_CONFLICT');
  assert.equal(e.details.server_body,'手機寫入');return true;
 });
 assert.equal((await getDraft(env,taskId)).body,'手機寫入');
});

test('核定 v1/v2 永不覆寫，核定當時來源快照及事後查證分離',async()=>{
 const {d,env}=fixture();
 await putDraft(env,taskId,{expected_revision:0,body:'人工核定的第一版'});
 await assert.rejects(()=>approveFinal(env,taskId,{
  expected_draft_revision:1,base_final_id:null,decision:'partial',note:'理由'
 },'valid-final-key-001'),e=>e.code==='UNVERIFIED_ACK_REQUIRED');
 const v1=await approveFinal(env,taskId,{
  expected_draft_revision:1,base_final_id:null,decision:'partial',note:'人工判斷',
  acknowledge_unverified:true
 },'valid-final-key-001');
 assert.equal(v1.version_no,1);assert.equal(v1.snapshot_unverified_count,1);
 assert.equal(d.prepare('SELECT status FROM tasks').get().status,'closed');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM human_decisions').get().n,1);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM review_model_attempts').get().n,0);
 assert.equal((await getDraft(env,taskId)).revision,2);
 d.prepare("UPDATE source_checks SET status='verified',verified_by='human',verified_at='t2',revision=1 WHERE id='source1'").run();
 const first=await getFinal(env,taskId,v1.id);
 assert.equal(first.body,'人工核定的第一版');
 assert.equal(first.verification_at_approval[0].status,'pending');
 assert.equal(first.current_verification[0].status,'verified');
 await putDraft(env,taskId,{expected_revision:2,body:'人工核定第二版，不呼叫 AI'});
 const v2=await approveFinal(env,taskId,{
  expected_draft_revision:3,base_final_id:v1.id,decision:'manual_revision',note:'更正',
  acknowledge_unverified:false
 },'valid-final-key-002');
 assert.equal(v2.version_no,2);
 const versions=await listFinals(env,taskId);
 assert.deepEqual(versions.items.map(x=>x.version_no),[1,2]);
 assert.equal((await getFinal(env,taskId,v1.id)).body,'人工核定的第一版');
 assert.equal((await getFinal(env,taskId,v2.id)).body,'人工核定第二版，不呼叫 AI');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM human_decisions').get().n,1);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM task_rounds').get().n,1);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM review_model_attempts').get().n,0);
 assert.throws(()=>d.prepare("UPDATE final_versions SET body='hacked' WHERE id=?").run(v1.id),/FINAL_VERSION_IMMUTABLE/);
});

test('核定 idempotency key 相同內容返回相同版本，不同內容拒絕',async()=>{
 const {env}=fixture();
 await putDraft(env,taskId,{expected_revision:0,body:'正式版'});
 const input={expected_draft_revision:1,base_final_id:null,decision:'partial',
  note:'核定',acknowledge_unverified:true};
 const a=await approveFinal(env,taskId,input,'valid-final-key-003');
 const b=await approveFinal(env,taskId,input,'valid-final-key-003');
 assert.equal(a.id,b.id);assert.equal(b.duplicate,true);
 await assert.rejects(()=>approveFinal(env,taskId,{...input,note:'偷偷改寫'},'valid-final-key-003'),e=>e.code==='IDEMPOTENCY_PAYLOAD_CONFLICT');
});

test('已過期草稿版本及核定 parent 拒絕建立新版本',async()=>{
 const {env}=fixture();
 await putDraft(env,taskId,{expected_revision:0,body:'初稿'});
 const v1=await approveFinal(env,taskId,{
  expected_draft_revision:1,base_final_id:null,decision:'partial',note:'',
  acknowledge_unverified:true
 },'valid-final-key-004');
 await putDraft(env,taskId,{expected_revision:2,body:'新草稿'});
 await assert.rejects(()=>approveFinal(env,taskId,{
  expected_draft_revision:2,base_final_id:v1.id,decision:'partial',note:'',
  acknowledge_unverified:true
 },'valid-final-key-005'),e=>e.code==='DRAFT_VERSION_CONFLICT');
 await assert.rejects(()=>approveFinal(env,taskId,{
  expected_draft_revision:3,base_final_id:null,decision:'partial',note:'',
  acknowledge_unverified:true
 },'valid-final-key-006'),e=>e.code==='FINAL_PARENT_CONFLICT');
});

test('舊審查端點不能繞過人工定稿直接關閉任務',async()=>{
 const {env}=fixture();env.OWNER_TOKEN='t'.repeat(48);
 const req=new Request('https://example.workers.dev/api/tasks/'+taskId+'/review',{
  method:'POST',headers:{Authorization:'Bearer '+env.OWNER_TOKEN,'Content-Type':'application/json'},
  body:JSON.stringify({decision:'accept_chatgpt',note:'接受'})
 });
 const reply=await worker.fetch(req,env);
 assert.equal(reply.status,409);
 assert.match((await reply.json()).error,/人工草稿/);
});
