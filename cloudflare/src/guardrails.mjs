/** Login failure limiting and count-based API safety caps, persisted in Cloudflare D1. */
const encoder=new TextEncoder();
const MAX_FAILED_LOGINS=5;
const LOGIN_WINDOW_SECONDS=15*60;
const error=(status,message)=>Object.assign(new Error(message),{status});

async function visitorHash(request,env){
  // Cloudflare sets CF-Connecting-IP at its edge. HMAC avoids storing the raw IP address.
  const ip=request.headers.get('CF-Connecting-IP') || 'local-testing';
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.OWNER_TOKEN),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('login-visitor:'+ip)));
  return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
}
export async function checkLoginThrottle(request,env){
  if(!env.DB||!env.OWNER_TOKEN||env.OWNER_TOKEN.length<32)throw error(503,'登入安全配置尚未完成');
  const hash=await visitorHash(request,env);
  const now=Math.floor(Date.now()/1000);
  const row=await env.DB.prepare('SELECT failures,window_start,locked_until FROM login_rate_limits WHERE visitor_hash=?').bind(hash).first();
  if(row && Number(row.locked_until)>now)throw error(429,'登入失敗次數過多，請於15分鐘後再試');
  return {hash,now};
}
export async function registerLoginFailure(env,check){
  const {hash,now}=check;
  const expired=now-LOGIN_WINDOW_SECONDS;
  // One atomic UPSERT, so parallel failures cannot overwrite the count.
  await env.DB.prepare(`INSERT INTO login_rate_limits (visitor_hash,failures,window_start,locked_until) VALUES (?,1,?,0)
   ON CONFLICT(visitor_hash) DO UPDATE SET
   failures=CASE WHEN window_start <= ? THEN 1 ELSE failures+1 END,
   locked_until=CASE WHEN window_start <= ? THEN 0 WHEN failures+1 >= ? THEN ? ELSE locked_until END,
   window_start=CASE WHEN window_start <= ? THEN ? ELSE window_start END`)
   .bind(hash,now,expired,expired,MAX_FAILED_LOGINS,now+LOGIN_WINDOW_SECONDS,expired,now).run();
}
export async function resetLoginFailures(env,check){
  await env.DB.prepare('DELETE FROM login_rate_limits WHERE visitor_hash=?').bind(check.hash).run();
}
export async function guardedLogin(request,env,checkPassword){
  const check=await checkLoginThrottle(request,env);
  try{
    const result=await checkPassword(request,env);
    await resetLoginFailures(env,check);
    return result;
  }catch(e){
    if(e?.status===401)await registerLoginFailure(env,check);
    throw e;
  }
}
export function apiEnabled(env){return env.MODEL_API_ENABLED==='true';}
function safeLimit(value,fallback,max){
  const n=Number(value);
  return Number.isInteger(n)&&n>0&&n<=max?n:fallback;
}
export function modelCallCaps(env){
  return {
    perTask:safeLimit(env.MODEL_MAX_CALLS_PER_TASK,12,100),
    perDay:safeLimit(env.MODEL_MAX_CALLS_PER_DAY,12,200)
  };
}
export async function reserveModelCall(env,{taskId,roundId,provider,phase}){
  if(!apiEnabled(env))throw error(409,'API 自動模式預設關閉；啟用前須確認費用及額度');
  const caps=modelCallCaps(env), now=new Date().toISOString();
  const day=now.slice(0,10)+'T00:00:00.000Z';
  // Atomic conditional insert: count "attempts", not just successful outputs.
  // A failed network response may still have incurred provider charges.
  const result=await env.DB.prepare(`INSERT INTO model_call_attempts
   (id,task_id,round_id,provider,phase,requested_at,status)
   SELECT ?,?,?,?,?,?,'reserved'
   WHERE (SELECT COUNT(*) FROM model_call_attempts WHERE task_id=?) < ?
     AND (SELECT COUNT(*) FROM model_call_attempts WHERE requested_at>=?) < ?`)
    .bind(crypto.randomUUID(),taskId,roundId,provider,phase,now,taskId,caps.perTask,day,caps.perDay).run();
  if((result.meta?.changes??0)!==1)throw error(429,'已達 API 模型呼叫次數上限；為避免額外費用，本次停止呼叫');
  return {taskId,roundId,provider,phase,requestedAt:now};
}
export async function markModelCall(env,reservation,success){
  await env.DB.prepare(`UPDATE model_call_attempts SET status=? 
   WHERE task_id=? AND round_id=? AND provider=? AND phase=? AND requested_at=?`)
    .bind(success?'succeeded':'failed',reservation.taskId,reservation.roundId,reservation.provider,reservation.phase,reservation.requestedAt).run();
}
