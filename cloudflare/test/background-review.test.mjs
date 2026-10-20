import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundSelected,backgroundReady,enqueueReview,consumeReviewMessage} from '../src/background-review.mjs';
const id='11111111-1111-4111-8111-111111111111';
const providers={ready:()=>true,apiEnabled:()=>true};
function harness({status='new',mode='api',enabled=true,failSend=false}={}){
 const task={status,mode,queue_requested:0},sent=[];
 const DB={prepare(sql){
  return{bind(...params){return{
   first:async()=>{
    if(sql.startsWith('SELECT status,mode,queue_requested'))return {...task};
    throw Error('UNEXPECTED SQL SELECT '+sql);
   },
   run:async()=>{
    if(sql.includes('SET queue_requested=1')){
     if(task.queue_requested!==0)return{meta:{changes:0}};
     task.queue_requested=1;return{meta:{changes:1}};
    }
    if(sql.includes('SET queue_requested=0')){task.queue_requested=0;return{meta:{changes:1}};}
    throw Error('UNEXPECTED SQL UPDATE '+sql);
   }
  };}};
 }};
 const env={DB,BACKGROUND_JOBS_ENABLED:enabled?'true':'false',MODEL_API_ENABLED:'false',
  AI_REVIEW_QUEUE:{send:async x=>{if(failSend)throw Error('mock queue offline');sent.push(x);}}};
 return{task,env,sent};
}
function msg(body){let ack=0,retry=0;return{body,ack(){ack++;},retry(){retry++;},get acked(){return ack;},get retried(){return retry;}};}
const ok=(data)=>new Response(JSON.stringify(data),{status:200});
test('預設永遠停用背景工作，沒有 Queue 或任一模型憑證不接受啟動',async()=>{
 assert.equal(backgroundSelected({}),false);
 assert.equal(backgroundReady({BACKGROUND_JOBS_ENABLED:'true'},{ready:()=>false,apiEnabled:()=>true}),false);
 const {env,sent}=harness({enabled:false});
 await assert.rejects(()=>enqueueReview(env,id,providers),/尚未完成授權/);
 assert.equal(sent.length,0);
});
test('合法佇列只發出任務 ID，一次排程，重複點擊不重送',async()=>{
 const {env,task,sent}=harness();
 const a=await enqueueReview(env,id,providers);
 assert.deepEqual(a,{queued:true,duplicate:false,status:'new'});
 assert.deepEqual(sent,[{kind:'review_step',taskId:id}]);
 assert.equal(task.queue_requested,1);
 const b=await enqueueReview(env,id,providers);
 assert.equal(b.duplicate,true);assert.equal(sent.length,1);
 assert.ok(JSON.stringify(sent).length<200);
});
test('不存在的 Queue 不能啟動且未呼叫模型',async()=>{
 const {env}=harness();
 delete env.AI_REVIEW_QUEUE;
 await assert.rejects(()=>enqueueReview(env,id,providers),/尚未完成授權/);
});
test('送入 Queue 失敗時，釋放鎖並停止',async()=>{
 const {env,task}=harness({failSend:true});
 await assert.rejects(()=>enqueueReview(env,id,providers),/佇列暫時無法/);
 assert.equal(task.queue_requested,0);
});
test('六階段可由背景消費者獨立於瀏覽器執行，最後只待人工核定',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 let phases=0;
 while(sent.length){
  const m=msg(sent.shift());
  const result=await consumeReviewMessage(m,env,{...providers,advance:async()=>{
   phases++;
   return ok({status:phases===3?'awaiting_human':'running',errors:[]});
  }});
  assert.equal(m.acked,1);
  assert.equal(m.retried,0);
  assert.ok(['continued','awaiting_human'].includes(result.outcome));
 }
 assert.equal(phases,3);
 assert.equal(task.queue_requested,0);
});
test('模型失敗時停止自動重試，不會額外收費',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 const m=msg(sent.shift());let calls=0;
 const r=await consumeReviewMessage(m,env,{...providers,advance:async()=>{
  calls++;return ok({status:'running',errors:[{provider:'gemini',message:'429'}]});
 }});
 assert.equal(r.outcome,'paused');assert.equal(r.reason,'model_error');
 assert.equal(calls,1);assert.equal(m.acked,1);assert.equal(sent.length,0);assert.equal(task.queue_requested,0);
});
test('不重送已失效的任務與錯誤格式訊息',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 const invalid=msg({kind:'bogus',taskId:id});
 const r=await consumeReviewMessage(invalid,env,{...providers,advance:async()=>{throw Error('should not invoke');}});
 assert.equal(r.outcome,'ignored');assert.equal(invalid.acked,1);
 task.status='closed';
 const stale=msg(sent.shift());
 assert.equal((await consumeReviewMessage(stale,env,{...providers,advance:async()=>{throw Error('should not invoke');}})).outcome,'stale');
});
test('缺少模型授權則取消排程，不進行假模型運算',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 const m=msg(sent.shift());
 const r=await consumeReviewMessage(m,env,{ready:()=>false,apiEnabled:()=>false,advance:async()=>{throw Error('no model');}});
 assert.equal(r.outcome,'disabled');assert.equal(task.queue_requested,0);assert.equal(m.acked,1);
});
test('併行訊息不應解鎖原工作，避免新排程覆蓋進度',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 const m=msg(sent.shift());
 const result=await consumeReviewMessage(m,env,{...providers,advance:async()=>{
  throw Object.assign(new Error('其他 AI 審查請求正在執行，請稍後再試'),{status:409});
 }});
 assert.equal(result.outcome,'concurrent');assert.equal(task.queue_requested,1);assert.equal(m.acked,1);
});
test('模型成功但送下一階段 Queue 失敗，請求佇列重試',async()=>{
 const {env,task,sent}=harness();
 await enqueueReview(env,id,providers);
 const m=msg(sent.shift());
 env.AI_REVIEW_QUEUE.send=async()=>{throw Error('fake temporary queue failure');};
 const result=await consumeReviewMessage(m,env,{...providers,advance:async()=>ok({status:'running',errors:[]})});
 assert.equal(result.outcome,'retry_queue');assert.equal(task.queue_requested,1);assert.equal(m.retried,1);
});
