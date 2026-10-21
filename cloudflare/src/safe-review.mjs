/**
 * Phase 2: durable model attempts and conservative Queue orchestration.
 * No model API calls until an authenticated owner starts an API-mode task with
 * MODEL_API_ENABLED and BACKGROUND_JOBS_ENABLED explicitly true.
 * Queue messages carry only job UUIDs. Ambiguous paid attempts never auto-retry.
 */
import {callModel,makePrompt,ready} from './models.mjs';
import {apiEnabled,reserveModelCall,markModelCall} from './guardrails.mjs';
import {getPreviousReworkNote} from './review-context.mjs';

const phases=['independent','critique','proposal'],providers=['chatgpt','gemini'];
const uuid=()=>crypto.randomUUID(),iso=()=>new Date().toISOString();
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
export const safeEnabled=env=>env?.BACKGROUND_JOBS_ENABLED==='true'&&apiEnabled(env);
export function requireSafeReady(env){
 if(!safeEnabled(env)||!ready(env)||typeof env.AI_REVIEW_QUEUE?.send!=='function')
  throw fail(409,'雙模型背景功能尚未授權或綁定','MODEL_API_DISABLED');
}
export function nextProvider(records,phase){
 const names=new Set(records.filter(x=>x.phase===phase).map(x=>x.provider));
 return providers.find(x=>!names.has(x))||null;
}
export function attemptPolicy(previous,alreadySaved,authorized){
 if(alreadySaved)return 'already_persisted';
 if(!previous)return 'initial';
 return authorized?'human_retry':'needs_human';
}
export function nextPhase(phase,records){
 if(nextProvider(records,phase))return {phase,state:'queued'};
 if(phase==='independent')return {phase:'critique',state:'queued'};
 // Phase 3 introduces strict structured-critique parsing. Until it exists,
 // stop rather than silently advancing from free text to "validated" review.
 if(phase==='critique')return {phase:'critique',state:'paused_parse'};
 return {phase:'proposal',state:'awaiting_human'};
}
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const many=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const latest=async(db,round,provider,phase)=>(await many(db,
 'SELECT * FROM review_model_attempts WHERE round_id=? AND provider=? AND phase=? ORDER BY attempt_no DESC',round,provider,phase))[0];
const entries=(db,round)=>many(db,'SELECT id,provider,phase,body,source FROM ai_outputs WHERE round_id=? ORDER BY created_at',round);
async function pause(db,jobId,reason,state='paused_failure'){
 return run(db,"UPDATE review_jobs SET state=?,reason_code=?,lease_until=0,revision=revision+1,updated_at=? WHERE id=? AND state NOT IN ('completed','awaiting_human')",
  state,reason,iso(),jobId);
}
async function pending(db,jobId=null){
 return jobId
  ?many(db,"SELECT id,job_id FROM queue_outbox WHERE state='pending' AND job_id=? ORDER BY created_at LIMIT 25",jobId)
  :many(db,"SELECT id,job_id FROM queue_outbox WHERE state='pending' ORDER BY created_at LIMIT 25");
}
async function dispatch(env,jobId=null){
 const rows=await pending(env.DB,jobId);let sent=0,failed=0;
 for(const x of rows)try{
  await env.AI_REVIEW_QUEUE.send({kind:'review_job',jobId:x.job_id});
  await run(env.DB,"UPDATE queue_outbox SET state='sent',updated_at=? WHERE id=? AND state='pending'",iso(),x.id);
  sent++;
 }catch{failed++;}
 return {sent,failed};
}
export async function dispatchSafeOutbox(env){
 requireSafeReady(env);return dispatch(env);
}
export async function startSafeReview(env,taskId){
 requireSafeReady(env);
 const db=env.DB,t=await one(db,'SELECT * FROM tasks WHERE id=?',taskId);
 if(!t)throw fail(404,'找不到任務');
 if(t.mode!=='api'||!['new','needs_rework','failed'].includes(t.status))
  throw fail(409,'目前狀態不可建立新的雙 AI 回合');
 const existing=await one(db,"SELECT id FROM review_jobs WHERE task_id=? AND state NOT IN ('completed','awaiting_human') LIMIT 1",taskId);
 if(existing)throw fail(409,'已有背景工作，請先查看恢復狀態');
 const saved=await run(db,"UPDATE tasks SET queue_requested=1,updated_at=? WHERE id=? AND queue_requested=0 AND status IN ('new','needs_rework','failed')",iso(),taskId);
 if((saved.meta?.changes??0)!==1)throw fail(409,'已有工作在排程，請重新整理');
 const last=await one(db,'SELECT ordinal FROM task_rounds WHERE task_id=? ORDER BY ordinal DESC LIMIT 1',taskId);
 const roundId=uuid(),jobId=uuid(),now=iso();
 try{
  await db.batch([
   db.prepare("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,?,'running',?)").bind(roundId,taskId,(last?.ordinal||0)+1,now),
   db.prepare("INSERT INTO review_jobs(id,task_id,round_id,phase,state,updated_at) VALUES(?,?,?,'independent','queued',?)").bind(jobId,taskId,roundId,now),
   db.prepare("INSERT INTO queue_outbox(id,job_id,action,state,created_at,updated_at) VALUES(?,?,'start','pending',?,?)").bind(uuid(),jobId,now,now),
   db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").bind(now,taskId)
  ]);
 }catch{
  await run(db,"UPDATE tasks SET queue_requested=0 WHERE id=? AND NOT EXISTS(SELECT 1 FROM review_jobs WHERE task_id=?)",taskId,taskId);
  throw fail(503,'建立背景工作失敗，沒有呼叫模型');
 }
 const delivery=await dispatch(env,jobId);
 return {queued:true,job_id:jobId,round_id:roundId,delivery_pending:delivery.failed>0};
}
export async function recoveryState(env,taskId){
 const db=env.DB,t=await one(db,'SELECT id FROM tasks WHERE id=?',taskId);
 if(!t)throw fail(404,'找不到任務');
 const job=await one(db,'SELECT * FROM review_jobs WHERE task_id=? ORDER BY updated_at DESC LIMIT 1',taskId);
 if(!job)return {task_id:taskId,status:'not_started',attempts:[],persisted_outputs:[],allowed_actions:[]};
 const rec=await entries(db,job.round_id);
 const att=await many(db,'SELECT id,provider,phase,attempt_no,state,started_at,updated_at FROM review_model_attempts WHERE job_id=? ORDER BY started_at',job.id);
 const charge=x=>['request_started','response_received','outcome_unknown'].includes(x.state);
 return {task_id:taskId,job_id:job.id,job_revision:job.revision,status:job.state,current_phase:job.phase,
  reason_code:job.reason_code,persisted_outputs:rec.map(x=>({id:x.id,provider:x.provider,phase:x.phase})),
  attempts:att.map(x=>({...x,potential_additional_charge:charge(x)})),
  risk_warning:att.some(charge)?'模型可能已計費但結果未保存，重試可能產生額外費用':null,
  allowed_actions:job.state==='paused_failure'?['retry_missing_after_ack']:[]};
}
export async function authorizeRetry(env,taskId,input,key){
 requireSafeReady(env);
 if(input?.acknowledge_possible_charge!==true||typeof input.reason!=='string'||!input.reason.trim())
  throw fail(422,'需要明確確認可能的額外計費及理由','CHARGE_ACK_REQUIRED');
 if(typeof key!=='string'||key.length<12||key.length>160)throw fail(422,'Idempotency-Key 無效');
 if(!providers.includes(input.provider)||!phases.includes(input.phase))throw fail(422,'模型階段無效');
 const db=env.DB,job=await one(db,'SELECT * FROM review_jobs WHERE id=?',input.job_id);
 if(!job||job.task_id!==taskId)throw fail(404,'找不到背景工作');
 const existing=await one(db,'SELECT * FROM retry_authorizations WHERE idempotency_key=?',key);
 if(existing){
  if(existing.job_id!==job.id||existing.provider!==input.provider||existing.phase!==input.phase)
   throw fail(409,'同一請求識別不可用於其他工作');
  return {queued:true,duplicate:true,job_id:job.id};
 }
 if(job.state!=='paused_failure'||job.phase!==input.phase||job.revision!==input.expected_job_revision)
  throw fail(409,'工作狀態已變更','JOB_VERSION_CONFLICT');
 if(await one(db,'SELECT id FROM ai_outputs WHERE round_id=? AND provider=? AND phase=?',job.round_id,input.provider,input.phase))
  throw fail(409,'該模型回覆已保存','ALREADY_PERSISTED');
 if(!await latest(db,job.round_id,input.provider,input.phase))throw fail(409,'沒有待確認的失敗嘗試');
 const now=iso(),auth=uuid();
 const result=await db.batch([
  db.prepare("INSERT INTO retry_authorizations(id,job_id,provider,phase,risk_ack,reason,idempotency_key,granted_at) SELECT ?,?,?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND state='paused_failure' AND phase=? AND revision=?)")
   .bind(auth,job.id,input.provider,input.phase,input.reason.trim(),key,now,job.id,input.phase,job.revision),
  db.prepare("UPDATE review_jobs SET state='queued',lease_until=0,reason_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='paused_failure' AND phase=? AND revision=? AND EXISTS(SELECT 1 FROM retry_authorizations WHERE id=?)")
   .bind(now,job.id,input.phase,job.revision,auth),
  db.prepare("INSERT INTO queue_outbox(id,job_id,action,state,created_at,updated_at) SELECT ?,?,'resume','pending',?,? WHERE EXISTS(SELECT 1 FROM retry_authorizations WHERE id=?)")
   .bind(uuid(),job.id,now,now,auth)
 ]);
 if((result[0].meta?.changes??0)!==1)throw fail(409,'重試票據已被其他請求使用','JOB_VERSION_CONFLICT');
 const delivery=await dispatch(env,job.id);
 return {queued:true,duplicate:false,job_id:job.id,delivery_pending:delivery.failed>0};
}
async function advanceSaved(env,job,records){
 const db=env.DB,next=nextPhase(job.phase,records),now=iso();
 const statements=[db.prepare("UPDATE review_jobs SET phase=?,state=?,reason_code=?,lease_until=0,revision=revision+1,updated_at=? WHERE id=?")
  .bind(next.phase,next.state,next.state==='paused_parse'?'PARSER_NOT_INSTALLED_PHASE3':null,now,job.id)];
 if(next.state==='queued')statements.push(db.prepare("INSERT INTO queue_outbox(id,job_id,action,state,created_at,updated_at) VALUES(?,?,'continue','pending',?,?)").bind(uuid(),job.id,now,now));
 if(next.state==='awaiting_human'){
  statements.push(db.prepare("UPDATE task_rounds SET state='awaiting_human' WHERE id=? AND state='running'").bind(job.round_id));
  statements.push(db.prepare("UPDATE tasks SET status='awaiting_human',queue_requested=0,updated_at=? WHERE id=?").bind(now,job.task_id));
 }
 await db.batch(statements);
 if(next.state==='queued')await dispatch(env,job.id);
 return next.state;
}
export async function consumeSafeMessage(message,env,deps={}){
 const {kind,jobId}=message?.body||{};
 if(kind!=='review_job'||typeof jobId!=='string'||!/^[0-9a-f-]{36}$/i.test(jobId)){message.ack?.();return {outcome:'ignored'};}
 if(!safeEnabled(env)||!ready(env)){message.ack?.();return {outcome:'disabled'};}
 const db=env.DB,job=await one(db,'SELECT * FROM review_jobs WHERE id=?',jobId);
 if(!job||!['queued','running'].includes(job.state)){message.ack?.();return {outcome:'stale'};}
 const task=await one(db,'SELECT * FROM tasks WHERE id=?',job.task_id);
 if(!task||task.status!=='running'){message.ack?.();return {outcome:'stale'};}
 const current=await entries(db,job.round_id),provider=nextProvider(current,job.phase);
 if(!provider){
  try{const state=await advanceSaved(env,job,current);message.ack?.();return {outcome:state};}
  catch{message.retry?.({delaySeconds:60});return {outcome:'retry_safe_control'};}
 }
 const prior=await latest(db,job.round_id,provider,job.phase);
 const ticket=prior?await one(db,'SELECT * FROM retry_authorizations WHERE job_id=? AND provider=? AND phase=? AND consumed_at IS NULL ORDER BY granted_at DESC LIMIT 1',job.id,provider,job.phase):null;
 if(attemptPolicy(prior,false,ticket)==='needs_human'){
  await pause(db,job.id,'OUTCOME_UNKNOWN');message.ack?.();return {outcome:'paused',reason:'needs_human'};
 }
 const t=Math.floor(Date.now()/1000);
 const lock=await run(db,"UPDATE review_jobs SET state='running',lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state IN ('queued','running') AND lease_until<?",t+190,iso(),job.id,job.revision,t);
 if((lock.meta?.changes??0)!==1){message.ack?.();return {outcome:'concurrent'};}
 let reservation;
 try{reservation=await (deps.reserveModelCall||reserveModelCall)(env,{taskId:job.task_id,roundId:job.round_id,provider,phase:job.phase});}
 catch{await pause(db,job.id,'QUOTA_OR_CONFIG');message.ack?.();return {outcome:'paused',reason:'quota'};}
 const attId=uuid(),outId=uuid(),now=iso();
 try{
  const statements=[];
  if(ticket)statements.push(db.prepare("UPDATE retry_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL").bind(now,ticket.id));
  statements.push(db.prepare("INSERT INTO review_model_attempts(id,job_id,round_id,provider,phase,attempt_no,state,started_at,updated_at) VALUES(?,?,?,?,?,?,'request_started',?,?)")
   .bind(attId,job.id,job.round_id,provider,job.phase,(prior?.attempt_no||0)+1,now,now));
  await db.batch(statements);
 }catch{await pause(db,job.id,'PRE_DISPATCH_FAILED');message.ack?.();return {outcome:'paused',reason:'pre_dispatch'};}
 let response;
 try{
  const round=await one(db,'SELECT ordinal FROM task_rounds WHERE id=?',job.round_id);
  const note=await getPreviousReworkNote(env,task.id,round.ordinal);
  response=await (deps.callModel||callModel)(provider,env,makePrompt(task,job.phase,provider,current,24000,note));
 }catch{
  try{await run(db,"UPDATE review_model_attempts SET state='outcome_unknown',updated_at=? WHERE id=? AND state='request_started'",iso(),attId);}catch{}
  try{await (deps.markModelCall||markModelCall)(env,reservation,false);}catch{}
  try{await pause(db,job.id,'PROVIDER_RESULT_UNKNOWN');}catch{}
  message.ack?.();return {outcome:'paused',reason:'provider_unknown'};
 }
 try{
  await run(db,"UPDATE review_model_attempts SET state='response_received',updated_at=? WHERE id=? AND state='request_started'",iso(),attId);
  const stamp=iso();
  await db.batch([
   db.prepare("INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at,source) VALUES(?,?,?,?,?,?,'api')").bind(outId,job.round_id,provider,job.phase,response,stamp),
   db.prepare("UPDATE review_model_attempts SET state='persisted',ai_output_id=?,updated_at=? WHERE id=? AND state='response_received'").bind(outId,stamp,attId)
  ]);
  try{await (deps.markModelCall||markModelCall)(env,reservation,true);}catch{}
 }catch{
  try{await run(db,"UPDATE review_model_attempts SET state='outcome_unknown',updated_at=? WHERE id=? AND state<>'persisted'",iso(),attId);}catch{}
  try{await pause(db,job.id,'PERSISTENCE_UNKNOWN');}catch{}
  message.ack?.();return {outcome:'paused',reason:'persistence_unknown'};
 }
 try{const state=await advanceSaved(env,job,await entries(db,job.round_id));message.ack?.();return {outcome:state,provider};}
 catch{message.retry?.({delaySeconds:60});return {outcome:'retry_safe_control'};}
}
export async function reconcileSafe(env){
 requireSafeReady(env);
 const now=Math.floor(Date.now()/1000);
 const stale=await many(env.DB,"SELECT id FROM review_jobs WHERE state='running' AND lease_until>0 AND lease_until<? LIMIT 25",now);
 for(const x of stale)await pause(env.DB,x.id,'LEASE_EXPIRED_NEEDS_HUMAN');
 return {...await dispatch(env),stale_paused:stale.length};
}
