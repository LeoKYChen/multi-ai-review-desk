/**
 * Explicitly opted-in server-side queue orchestration.
 * Never runs providers unless both MODEL_API_ENABLED and BACKGROUND_JOBS_ENABLED
 * are true and both model credentials are present. Queue messages contain only IDs.
 * This module NEVER fetches or logs private Word/document text.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed=new Set(['new','running','failed','needs_rework']);
const err=(status,message)=>Object.assign(new Error(message),{status});
export function backgroundSelected(env){return env?.BACKGROUND_JOBS_ENABLED==='true';}
export function backgroundReady(env,{ready,apiEnabled}){
 return backgroundSelected(env)&&apiEnabled(env)&&ready(env)&&typeof env.AI_REVIEW_QUEUE?.send==='function';
}
async function unlock(env,taskId){
 await env.DB.prepare('UPDATE tasks SET queue_requested=0 WHERE id=?').bind(taskId).run();
}
export async function enqueueReview(env,taskId,{ready,apiEnabled}){
 if(!backgroundReady(env,{ready,apiEnabled}))
  throw err(409,'背景審查尚未完成授權、Queue 或雙 AI 設定，不會啟動模型');
 if(!UUID.test(taskId))throw err(422,'任務 ID 無效');
 const task=await env.DB.prepare('SELECT status,mode,queue_requested FROM tasks WHERE id=?').bind(taskId).first();
 if(!task)throw err(404,'找不到任務');
 if(task.mode!=='api')throw err(409,'此任務不是 API 自動模式');
 if(!allowed.has(task.status))throw err(409,'任務已進入人工核定或已結案');
 if(task.queue_requested===1)return {queued:true,duplicate:true,status:task.status};
 const now=new Date().toISOString();
 const changed=await env.DB.prepare("UPDATE tasks SET queue_requested=1,updated_at=? WHERE id=? AND queue_requested=0 AND status IN ('new','running','failed','needs_rework')")
  .bind(now,taskId).run();
 if(changed.meta?.changes!==1)return {queued:true,duplicate:true,status:task.status};
 try{
  await env.AI_REVIEW_QUEUE.send({kind:'review_step',taskId});
 }catch{
  await unlock(env,taskId);
  throw err(503,'佇列暫時無法建立工作；沒有呼叫任何模型，請稍後重試');
 }
 return {queued:true,duplicate:false,status:task.status};
}
/**
 * Each Queue delivery executes at most ONE logical phase (up to 2 providers).
 * Reenqueue only on success; failure stops automatic paid retries.
 * The existing D1 per-task lock and immutable phase records are the source of truth.
 * Use a mock advance() for preauthorization tests, never live API.
 */
export async function consumeReviewMessage(message,env,{advance,ready,apiEnabled}){
 const value=message?.body||{},taskId=value.taskId;
 if(value.kind!=='review_step'||typeof taskId!=='string'||!UUID.test(taskId)){
  message.ack?.();return {outcome:'ignored'};
 }
 if(!backgroundReady(env,{ready,apiEnabled})){
  await unlock(env,taskId);
  message.ack?.();return {outcome:'disabled'};
 }
 const task=await env.DB.prepare('SELECT status,mode,queue_requested FROM tasks WHERE id=?').bind(taskId).first();
 if(!task||task.mode!=='api'||task.queue_requested!==1||!allowed.has(task.status)){
  message.ack?.();return {outcome:'stale'};
 }
 let reply;
 try{reply=await advance(env,taskId);}
 catch(e){
  // A duplicate delivery colliding with the currently running worker must not
  // cancel the original job; the current worker will enqueue the next stage.
  if(e.status===409&&/審查請求正在執行/.test(e.message||'')){
   message.ack?.();return {outcome:'concurrent'};
  }
  await unlock(env,taskId);message.ack?.();
  return {outcome:'paused',reason:'worker_error'};
 }
 if(reply.status===409){
  let problem;try{problem=await reply.clone().json();}catch{problem={};}
  if(/審查請求正在執行/.test(problem?.error||'')){
   message.ack?.();return {outcome:'concurrent'};
  }
  await unlock(env,taskId);message.ack?.();
  return {outcome:'paused',reason:'invalid_state'};
 }
 if(!reply.ok){
  await unlock(env,taskId);message.ack?.();
  return {outcome:'paused',reason:'invalid_response'};
 }
 let data;
 try{data=await reply.json();}catch{
  await unlock(env,taskId);message.ack?.();
  return {outcome:'paused',reason:'invalid_response'};
 }
 if(data.errors?.length){
  await unlock(env,taskId);message.ack?.();
  return {outcome:'paused',reason:'model_error'};
 }
 if(data.status==='running'){
  try{
   await env.AI_REVIEW_QUEUE.send({kind:'review_step',taskId});
   message.ack?.();return {outcome:'continued'};
  }catch{
   // Retry the queue message. On redelivery, D1 output uniqueness prevents
   // re-running a successfully recorded model stage, unless partial output failed.
   message.retry?.({delaySeconds:60});
   return {outcome:'retry_queue'};
  }
 }
 await unlock(env,taskId);message.ack?.();
 return {outcome:data.status==='awaiting_human'?'awaiting_human':'paused'};
}
