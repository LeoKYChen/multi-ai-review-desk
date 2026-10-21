import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {requireSafeReady,nextProvider,attemptPolicy,nextPhase,startSafeReview,
 consumeSafeMessage,recoveryState,authorizeRetry,reconcileSafe,resumeParsedReview} from '../src/safe-review.mjs';
import {resolveCritique} from '../src/review-evidence.mjs';

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


test('併發 Queue 重送不會暫停仍在執行的合法模型請求',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 const original=x.shift();
 let finish,started=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 const first=consumeSafeMessage(x.msg(original),x.env,{
  ...x.deps,callModel:async()=>{started++;return pending;}
 });
 // Wait only for the local fake D1 attempt to enter request_started.
 let row;
 for(let i=0;i<100;i++){
  row=x.sql.prepare('SELECT state FROM review_model_attempts LIMIT 1').get();
  if(row?.state==='request_started')break;
  await new Promise(resolve=>setImmediate(resolve));
 }
 assert.equal(row?.state,'request_started');
 const duplicate=await consumeSafeMessage(x.msg(original),x.env,{
  ...x.deps,callModel:async()=>{throw Error('duplicate must not call a provider');}
 });
 assert.equal(duplicate.outcome,'concurrent');
 assert.equal(x.sql.prepare('SELECT state FROM review_jobs').get().state,'running');
 finish('Original model reply');
 assert.equal((await first).outcome,'queued');
 assert.equal(started,1);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,1);
});

test('失去控制訊息而租約過期，只有已持久化的工作可自動安全恢復',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=> 'committed result'
 });
 // Simulate a lost control message after one output was durably stored.
 x.sent.length=0;
 x.sql.prepare("UPDATE review_jobs SET state='running',lease_until=1 WHERE task_id=?").run(x.id);
 const rec=await reconcileSafe(x.env);
 assert.equal(rec.safe_resumed,1);
 assert.equal(rec.stale_paused,0);
 assert.equal(x.sql.prepare('SELECT state FROM review_jobs').get().state,'queued');
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,1);
 assert.ok(x.sent.length>0);
});

test('租約過期且付費結果未明，只能暫停不得安全續跑',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=>{throw Error('provider possibly charged');}
 });
 x.sql.prepare("UPDATE review_jobs SET state='running',lease_until=1 WHERE task_id=?").run(x.id);
 const rec=await reconcileSafe(x.env);
 assert.equal(rec.safe_resumed,0);
 assert.equal(rec.stale_paused,1);
 assert.equal((await recoveryState(x.env,x.id)).status,'paused_failure');
 assert.equal(x.sent.length,0);
});

test('Idempotency-Key 不能用不同人工理由替換已確認重試',async()=>{
 const x=fixture();await startSafeReview(x.env,x.id);
 await consumeSafeMessage(x.msg(x.shift()),x.env,{
  ...x.deps,callModel:async()=>{throw Error('provider timeout');}
 });
 const s=await recoveryState(x.env,x.id);
 const payload={job_id:s.job_id,expected_job_revision:s.job_revision,provider:'chatgpt',
  phase:'independent',acknowledge_possible_charge:true,reason:'原先確認的理由'};
 await authorizeRetry(x.env,x.id,payload,'retry-reason-unique');
 await assert.rejects(()=>authorizeRetry(x.env,x.id,{...payload,reason:'不同理由'},'retry-reason-unique'),
  /請求的內容不一致/);
});


test('有效 JSON 異議在三階段保存完整六份，最終仍等待本人核定',async()=>{
 const x=fixture(),calls=[];
 await startSafeReview(x.env,x.id);
 for(let n=0;n<6;n++){
  const msg=x.shift();assert.ok(msg,'expected queue message '+n);
  const r=await consumeSafeMessage(x.msg(msg),x.env,{...x.deps,
   callModel:async(provider,_env,prompt)=>{
    calls.push(provider);
    if(prompt.includes('【第一階段：獨立分析】'))return provider+' 的初評原句';
    if(prompt.includes('【第二階段：交叉審查】')){
     const target=provider==='chatgpt'?'gemini':'chatgpt';
     const payload={objections:[{target_provider:target,quote:target+' 的初評原句',reason:'應再查證'}]};
     return '我提出評論。\nBEGIN_FEEDBACK_OBJECTIONS\n'+JSON.stringify(payload)+'\nEND_FEEDBACK_OBJECTIONS';
    }
    return provider+' 最終修正建議';
   }});
  assert.equal(r.outcome,n===5?'awaiting_human':'queued');
 }
 assert.deepEqual(calls,['chatgpt','gemini','chatgpt','gemini','chatgpt','gemini']);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,6);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM review_objections').get().n,2);
 assert.equal(x.sql.prepare("SELECT COUNT(*) n FROM critique_parse_status WHERE status='valid'").get().n,2);
 assert.equal(x.sql.prepare('SELECT status FROM tasks').get().status,'awaiting_human');
 assert.equal(x.sql.prepare('SELECT queue_requested FROM tasks').get().queue_requested,0);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM final_versions').get().n,0);
});

test('解析失敗：本人逐份確認後只續行缺漏 proposal，不重複付費 critique',async()=>{
 const x=fixture();const start=await startSafeReview(x.env,x.id);
 for(let n=0;n<4;n++){
  const msg=x.shift();
  await consumeSafeMessage(x.msg(msg),x.env,{...x.deps,callModel:async(provider,_e,prompt)=>{
   if(prompt.includes('【第一階段'))return provider+' 初評';
   return '可閱讀評論，但缺結構化異議';
  }});
 }
 assert.equal((await recoveryState(x.env,x.id)).status,'paused_parse');
 assert.equal(x.sql.prepare('SELECT queue_requested FROM tasks').get().queue_requested,0);
 const critiques=x.sql.prepare("SELECT id FROM ai_outputs WHERE phase='critique' ORDER BY provider").all();
 assert.equal(critiques.length,2);
 await resolveCritique(x.env,x.id,start.round_id,critiques[0].id);
 assert.equal((await resumeParsedReview(x.env,x.id,start.round_id)).resumed,false);
 await resolveCritique(x.env,x.id,start.round_id,critiques[1].id);
 assert.equal((await resumeParsedReview(x.env,x.id,start.round_id)).resumed,true);
 assert.equal(x.sql.prepare('SELECT queue_requested FROM tasks').get().queue_requested,1);
 let proposalCount=0;
 for(let n=0;n<2;n++){
  await consumeSafeMessage(x.msg(x.shift()),x.env,{...x.deps,
   callModel:async(provider)=>{proposalCount++;return provider+' 新版修正建議';}});
 }
 assert.equal(proposalCount,2);
 assert.equal(x.sql.prepare('SELECT COUNT(*) n FROM ai_outputs').get().n,6);
 assert.equal((await recoveryState(x.env,x.id)).status,'awaiting_human');
});
