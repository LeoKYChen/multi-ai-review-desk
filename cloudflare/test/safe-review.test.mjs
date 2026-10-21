import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {requireSafeReady,nextProvider,attemptPolicy,nextPhase,startSafeReview,
 consumeSafeMessage,recoveryState,authorizeRetry,reconcileSafe} from '../src/safe-review.mjs';

function fixture(){
 const dir=dirname(fileURLToPath(import.meta.url));
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 const migrationDir=resolve(dir,'../migrations');
 for(const name of readdirSync(migrationDir).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort())
  sql.exec(readFileSync(resolve(migrationDir,name),'utf-8'));
 const db={
  failNextOutputBatch:false,
  prepare(text){return {bind(...args){
   const statement=sql.prepare(text);
   return {sourceSQL:text,
    first:async()=>statement.get(...args)||null,
    all:async()=>({results:statement.all(...args)}),
    run:async()=>({meta:{changes:statement.run(...args).changes}})
   };
  }};},
  async batch(statements){
   sql.exec('BEGIN');
   try{
    const results=[];
    for(const statement of statements){
     if(db.failNextOutputBatch&&statement.sourceSQL.includes('INSERT INTO ai_outputs')){
      db.failNextOutputBatch=false;throw Error('simulated D1 failure');
     }
     results.push(await statement.run());
    }
    sql.exec('COMMIT');return results;
   }catch(e){sql.exec('ROLLBACK');throw e;}
  }
 };
 const id='11111111-1111-4111-8111-111111111111';
 sql.prepare("INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at,mode) VALUES(?,?,?,?,'new',?,?,'api')")
  .run(id,'模擬審查','請提供雙方意見','','t0','t0');
 const sent=[],env={DB:db,MODEL_API_ENABLED:'true',BACKGROUND_JOBS_ENABLED:'true',
  OPENAI_API_KEY:'test-placeholder',OPENAI_MODEL:'mock-openai',
  GEMINI_API_KEY:'test-placeholder',GEMINI_MODEL:'mock-gemini',
  AI_REVIEW_QUEUE:{async send(data){sent.push({body:data});}}
 };
 const msg=m=>({...m,ack(){},retry(){}});
 const deps={reserveModelCall:async()=>({fake:true}),markModelCall:async()=>{}};
 return {sql,db,env,id,sent,msg,deps,shift:()=>sent.shift()};
}

test('純狀態決策：初評隔離、重試需授權、critique 待 Phase 3 解析',()=>{
 assert.equal(nextProvider([],'independent'),'chatgpt');
 assert.equal(nextProvider([{phase:'independent',provider:'chatgpt'}],'independent'),'gemini');
 assert.equal(attemptPolicy(null,false,false),'initial');
 assert.equal(attemptPolicy({state:'outcome_unknown'},false,false),'needs_human');
 assert.equal(attemptPolicy({state:'outcome_unknown'},false,true),'human_retry');
 assert.equal(attemptPolicy({state:'persisted'},true,true),'already_persisted');
 assert.deepEqual(nextPhase('independent',[
  {phase:'independent',provider:'chatgpt'},{phase:'independent',provider:'gemini'}]),
  {phase:'critique',state:'queued'});
 assert.deepEqual(nextPhase('critique',[
  {phase:'critique',provider:'chatgpt'},{phase:'critique',provider:'gemini'}]),
  {phase:'critique',state:'paused_parse'});
});

test('未授權不排程、無模型呼叫',async()=>{
 const x=fixture();x.env.MODEL_API_ENABLED='false';
 assert.throws(()=>requireSafeReady(x.env),/尚未授權/);
 await assert.rejects(()=>startSafeReview(x.env,x.id),/尚未授權/);
 assert.equal(x.sent.length,0);
});

test('兩份獨立初評與兩份交叉評論落庫；正式解析未完成必須暫停',async()=>{
 const x=fixture(),called=[];
 await startSafeReview(x.env,x.id);
 for(let n=0;n<4;n++){
  const message=x.shift();assert.ok(message,'step '+n+' queued');
  const r=await consumeSafeMessage(x.msg(message),x.env,{
   ...x.deps,callModel:async(provider,_env,prompt)=>{
    called.push(provider);assert.match(prompt,/請提供雙方意見/);return provider+' mock review '+n;
   }});
  assert.equal(r.outcome,n===3?'paused_parse':'queued');
 }
 assert.deepEqual(called,['chatgpt','gemini','chatgpt','gemini']);
 assert.equal(x.sent.length,0);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,4);
 assert.equal(x.sql.prepare("SELECT COUNT(*) n FROM review_model_attempts WHERE state='persisted'").get().n,4);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM final_versions').get().n,0);
 assert.equal((await recoveryState(x.env,x.id)).status,'paused_parse');
});

test('Provider 逾時：結果未知、不自動重試',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 let calls=0;
 const r=await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=>{calls++;throw Error('mock timeout');}
 });
 assert.equal(r.reason,'provider_unknown');assert.equal(calls,1);
 assert.equal(x.sent.length,0);
 const recovery=await recoveryState(x.env,x.id);
 assert.equal(recovery.status,'paused_failure');
 assert.equal(recovery.attempts[0].state,'outcome_unknown');
 assert.equal(recovery.attempts[0].potential_additional_charge,true);
 assert.equal((await consumeSafeMessage(x.msg({body:{kind:'review_job',jobId:recovery.job_id}}),x.env,{
  ...x.deps,callModel:async()=>{calls++;}
 })).outcome,'stale');
 assert.equal(calls,1);
});

test('Provider 成功、D1 失敗：沒有 persisted 輸出，必須人工確認',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 x.db.failNextOutputBatch=true;
 const r=await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=> 'received but not saved'
 });
 assert.equal(r.reason,'persistence_unknown');
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,0);
 assert.equal(x.sql.prepare('SELECT state FROM review_model_attempts').get().state,'outcome_unknown');
});

test('需風險確認及冪等 key 才能重新呼叫遺失的模型',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=>{throw Error('model timeout');}
 });
 const state=await recoveryState(x.env,x.id);
 const body={job_id:state.job_id,expected_job_revision:state.job_revision,
  provider:'chatgpt',phase:'independent',acknowledge_possible_charge:true,
  reason:'已確認有重複計費風險'};
 await assert.rejects(()=>authorizeRetry(x.env,x.id,{...body,acknowledge_possible_charge:false},'test-retry-key-1'),/重複計費/);
 assert.equal((await authorizeRetry(x.env,x.id,body,'test-retry-key-1')).duplicate,false);
 assert.equal((await authorizeRetry(x.env,x.id,body,'test-retry-key-1')).duplicate,true);
 assert.equal(x.sent.length,1);
 let calls=0;
 const next=await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=>{calls++;return 'retried result';}
 });
 assert.equal(next.outcome,'queued');assert.equal(calls,1);
 assert.equal(x.sql.prepare("SELECT COUNT(*) n FROM retry_authorizations").get().n,1);
 assert.equal(x.sql.prepare("SELECT COUNT(*) n FROM review_model_attempts WHERE provider='chatgpt'").get().n,2);
});

test('Queue send 暫時失敗，outbox 可安全恢復，只重送控制訊息',async()=>{
 const x=fixture();let down=true;
 x.env.AI_REVIEW_QUEUE.send=async msg=>{if(down)throw Error('queue offline');x.sent.push({body:msg});};
 assert.equal((await startSafeReview(x.env,x.id)).delivery_pending,true);
 assert.equal(x.sent.length,0);down=false;
 const result=await reconcileSafe(x.env);
 assert.equal(result.sent,1);assert.equal(x.sent.length,1);
 assert.equal(x.sql.prepare('SELECT state FROM queue_outbox').get().state,'sent');
});

test('重複控制訊息不得重跑已保存的 ChatGPT 階段',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 const message=x.shift();let calls=0;
 await consumeSafeMessage(x.msg(message),x.env,{...x.deps,callModel:async()=>{calls++;return 'first';}});
 await consumeSafeMessage(x.msg(message),x.env,{...x.deps,callModel:async(provider)=>{
  calls++;assert.equal(provider,'gemini');return 'second';
 }});
 assert.equal(calls,2);
 assert.equal(x.sql.prepare("SELECT COUNT(*) n FROM ai_outputs WHERE provider='chatgpt' AND phase='independent'").get().n,1);
});
