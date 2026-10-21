/** D1-only private-review backend. Model calls require separately configured API keys. */
import { extractDocxText, MAX_DOCX_BYTES } from './docx.mjs';
import { callModel, makePrompt, ready } from './models.mjs';
import { hasHumanAuth, login, logoutHeaders } from './session.mjs';
import { beginManual, getManualNext, submitManual } from './manual.mjs';
import { guardedLogin, apiEnabled, reserveModelCall, markModelCall, modelCallCaps } from './guardrails.mjs';
import { renderTaskMarkdown } from './export.mjs';
import { getPreviousReworkNote } from './review-context.mjs';
import {parseTaskFilters,buildTaskListQuery} from './task-query.mjs';
import { safeEnabled, startSafeReview, recoveryState, authorizeRetry, dispatchSafeOutbox, consumeSafeMessage, reconcileSafe } from './safe-review.mjs';

const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const respond=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...jsonHeaders,...extra}});
const iso=()=>new Date().toISOString();
const uuid=()=>crypto.randomUUID();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const assert=(ok,status,message)=>{if(!ok)fail(status,message);};
const validText=(x,n)=>typeof x==='string'&&x.length<=n;
const sameOrigin=req=>{const origin=req.headers.get('Origin');if(origin)assert(origin===new URL(req.url).origin,403,'已拒絕跨來源要求');};
async function body(req){
 assert(req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'),415,'請使用 application/json');
 assert(Number(req.headers.get('Content-Length')||0)<110000,413,'內容過大');
 const raw=await req.text();assert(raw.length<110000,413,'內容過大');
 try{return JSON.parse(raw);}catch{fail(400,'JSON 格式錯誤');}
}
async function task(env,id){const value=await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();assert(value,404,'找不到任務');return value;}
async function roundFor(env,id){return env.DB.prepare('SELECT * FROM task_rounds WHERE task_id=? ORDER BY ordinal DESC LIMIT 1').bind(id).first();}
async function recordsFor(env,roundId){return (await env.DB.prepare('SELECT provider,phase,body,created_at,source FROM ai_outputs WHERE round_id=? ORDER BY created_at').bind(roundId).all()).results;}
async function createTask(req,env){
 assert(req.headers.get('Content-Type')?.startsWith('multipart/form-data'),415,'請使用 multipart/form-data');
 assert(Number(req.headers.get('Content-Length')||0)<MAX_DOCX_BYTES+100000,413,'附件過大');
 const form=await req.formData();const title=form.get('title'),instruction=form.get('instruction'),file=form.get('document');
 const mode=form.get('mode')||'manual';assert(mode==='manual'||mode==='api',422,'工作模式不正確');
 const category=form.get('category')||'一般';assert(typeof category==='string'&&category.trim().length>0&&category.length<=30,422,'分類不得超過30字元');
 assert(typeof title==='string'&&title.trim()&&title.length<=180,422,'任務標題無效');
 assert(typeof instruction==='string'&&instruction.trim()&&instruction.length<=20000,422,'交辦指令無效');
 let documentText='',documentName=null,warnings=[];
 if(file!==null){
  assert(typeof file!=='string'&&typeof file.arrayBuffer==='function',422,'Word 附件格式無效');
  assert(/^.{1,180}\.docx$/i.test(file.name),422,'只支援 .docx');
  assert(file.size>0&&file.size<=MAX_DOCX_BYTES,413,'Word 檔案不能超過 3 MB');
  const extracted=extractDocxText(new Uint8Array(await file.arrayBuffer()));
  documentText=extracted.text;documentName=file.name;warnings=extracted.warnings;
 }
 const id=uuid(),now=iso();
 await env.DB.prepare('INSERT INTO tasks (id,title,instruction,document_text,document_name,status,created_at,updated_at,mode,category) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .bind(id,title.trim(),instruction.trim(),documentText,documentName,'new',now,now,mode,category.trim()).run();
 return respond({id,title:title.trim(),status:'new',mode,category:category.trim(),document_name:documentName,extracted_characters:documentText.length,warnings},201);
}
async function readFullTask(env,id){
 const t=await task(env,id);
 const rounds=(await env.DB.prepare('SELECT * FROM task_rounds WHERE task_id=? ORDER BY ordinal').bind(id).all()).results;
 const result=[];
 for(const r of rounds){const outputs=await recordsFor(env,r.id);const review=await env.DB.prepare('SELECT decision,note,created_at FROM human_decisions WHERE round_id=?').bind(r.id).first();result.push({...r,outputs,review});}
 return {...t,rounds:result};
}
async function detail(env,id){return respond(await readFullTask(env,id));}
async function newRound(env,taskId){
 const t=await task(env,taskId);assert(['new','needs_rework','failed'].includes(t.status),409,'任務狀態不可建立新回合');
 const prev=await env.DB.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM task_rounds WHERE task_id=?').bind(taskId).first();
 const ordinal=prev.n+1,id=uuid(),now=iso();
 await env.DB.batch([
  env.DB.prepare('INSERT INTO task_rounds (id,task_id,ordinal,state,created_at) VALUES (?,?,?,?,?)').bind(id,taskId,ordinal,'running',now),
  env.DB.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").bind(now,taskId)
 ]);
 return {id,task_id:taskId,ordinal,state:'running'};
}
const phases=['independent','critique','proposal'];
async function advance(env,taskId,fetcher){
 assert(ready(env)&&apiEnabled(env),409,'API 自動執行未啟用或缺少模型憑證；不會產生模擬結果，也不會向 API 計費');
 const t=await task(env,taskId);
 assert(t.mode==='api',409,'此任務使用網頁版輔助模式，請從手動審查畫面操作');
 assert(['new','needs_rework','running','failed'].includes(t.status),409,'這張任務不能啟動 AI');
 const nowSec=Math.floor(Date.now()/1000);
 const lock=await env.DB.prepare('UPDATE tasks SET run_lock_until=? WHERE id=? AND run_lock_until < ?')
  .bind(nowSec+190,taskId,nowSec).run();
 assert((lock.meta?.changes??0)===1,409,'其他 AI 審查請求正在執行，請稍後再試');
 try {
 let round=(t.status==='running'?await roundFor(env,taskId):null);
 if(!round) round=await newRound(env,taskId);
 assert(round.state==='running',409,'回合狀態不允許繼續');
 const records=await recordsFor(env,round.id);
 const phase=phases.find(p=>records.filter(x=>x.phase===p).length!==2);
 if(!phase)return respond({status:'awaiting_human',message:'AI 建議已齊，等待你的決定'});
 const phaseIdx=phases.indexOf(phase);
 if(phaseIdx>0)assert(records.filter(x=>x.phase===phases[phaseIdx-1]).length===2,409,'前一階段尚未完成');
 const missing=['chatgpt','gemini'].filter(p=>!records.some(x=>x.provider===p&&x.phase===phase));
 let prompts;
 try {
  const reviewNote=await getPreviousReworkNote(env,taskId,round.ordinal);
  prompts=missing.map(provider=>({provider,prompt:makePrompt(t,phase,provider,records,24000,reviewNote)}));
 }
 catch(e){fail(422,e.message);}
 const replies=await Promise.allSettled(prompts.map(async x=>{
   // Reservation counts attempts, even if the provider times out or fails.
   const reservation=await reserveModelCall(env,{taskId,roundId:round.id,provider:x.provider,phase});
   try {
    const text=await callModel(x.provider,env,x.prompt,fetcher);
    await markModelCall(env,reservation,true);
    return {provider:x.provider,text};
   } catch (e) {
    await markModelCall(env,reservation,false);
    throw e;
   }
  }));
 const errors=[];let successful=0;
 for(let i=0;i<replies.length;i++){
  const result=replies[i];
  if(result.status!=='fulfilled'){errors.push({provider:prompts[i].provider,message:result.reason?.message||'模型執行失敗'});continue;}
  const now=iso();
  try{
   await env.DB.prepare('INSERT INTO ai_outputs (id,round_id,provider,phase,body,created_at) VALUES (?,?,?,?,?,?)')
    .bind(uuid(),round.id,result.value.provider,phase,result.value.text,now).run();successful++;
  }catch{errors.push({provider:result.value.provider,message:'儲存 AI 意見時發生衝突，請重新整理'});}
 }
 const updated=await recordsFor(env,round.id);
 const both=updated.filter(x=>x.phase==='proposal').length===2;
 if(both){const now=iso();await env.DB.batch([
  env.DB.prepare("UPDATE task_rounds SET state='awaiting_human' WHERE id=? AND state='running'").bind(round.id),
  env.DB.prepare("UPDATE tasks SET status='awaiting_human',updated_at=? WHERE id=? AND status='running'").bind(now,taskId)
 ]);}
 return respond({round_id:round.id,phase,successful,errors,status:both?'awaiting_human':'running',next_phase:both?null:phases.find(p=>updated.filter(x=>x.phase===p).length!==2)},200);
 } finally {
   await env.DB.prepare('UPDATE tasks SET run_lock_until=0 WHERE id=?').bind(taskId).run();
 }
}
async function humanReview(env,taskId,req){
 const input=await body(req);
 assert(input&&['accept_chatgpt','accept_gemini','partial','reject','rework'].includes(input.decision)&&validText(input.note,10000),422,'審查內容有誤');
 if(input.decision==='rework')assert(!!input.note?.trim(),422,'退回重新討論時，請填寫具體理由，供下一回合使用');
 const t=await task(env,taskId);assert(t.status==='awaiting_human',409,'兩位 AI 尚未各自提出修正建議');
 const round=await roundFor(env,taskId);assert(round?.state==='awaiting_human',409,'回合尚未進入人工審查');
 const now=iso(),status=input.decision==='rework'?'needs_rework':'closed';
 await env.DB.batch([
  env.DB.prepare('INSERT INTO human_decisions (id,round_id,decision,note,created_at) VALUES (?,?,?,?,?)').bind(uuid(),round.id,input.decision,input.note||'',now),
  env.DB.prepare('UPDATE task_rounds SET state=? WHERE id=?').bind(status,round.id),
  env.DB.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').bind(status,now,taskId)
 ]);
 return respond({status,human_reviewed:true,decision:input.decision});
}
export default {async fetch(req,env){
 try{
  assert(env?.DB,503,'尚未設定 D1 資料庫');sameOrigin(req);
  const pathname=new URL(req.url).pathname;
  if(pathname==='/api/login'&&req.method==='POST'){
   const result=await guardedLogin(req,env,login);return respond(result.data,200,result.headers);
  }
  if(pathname==='/api/session'&&req.method==='GET')return respond({authenticated:await hasHumanAuth(req,env)});
  if(pathname==='/api/logout'&&req.method==='POST')return respond({authenticated:false},200,logoutHeaders());
  assert(await hasHumanAuth(req,env),401,'請先登入');
  if(pathname==='/api/health'&&req.method==='GET')return respond({ok:true,storage:'D1',models_configured:ready(env)&&apiEnabled(env)});
  if(pathname==='/api/settings'&&req.method==='GET')return respond({models_configured:ready(env)&&apiEnabled(env),manual_mode_available:true,api_enabled:apiEnabled(env),api_call_caps:modelCallCaps(env),provider_names:['chatgpt','gemini'],uses_paid_api_credentials:true});
  if(pathname==='/api/tasks'&&req.method==='POST')return await createTask(req,env);
  if(pathname==='/api/tasks'&&req.method==='GET'){
   const filter=parseTaskFilters(new URL(req.url));
   const {sql,params}=buildTaskListQuery(filter);
   const rows=(await env.DB.prepare(sql).bind(...params).all()).results;
   return respond({tasks:rows,limit:100,filters:filter});
  }
  const exportRoute=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/export\.md$/);
  if(exportRoute&&req.method==='GET'){
   const content=renderTaskMarkdown(await readFullTask(env,exportRoute[1]));
   return new Response(content,{status:200,headers:{...jsonHeaders,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="multi-ai-task-${exportRoute[1]}.md"`}});
  }
  const manualRoute=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/manual-(begin|next|output)$/);
  if(manualRoute){
   const [,id,action]=manualRoute;
   if(action==='begin'&&req.method==='POST')return respond(await beginManual(env,id),201);
   if(action==='next'&&req.method==='GET')return respond(await getManualNext(env,id));
   if(action==='output'&&req.method==='POST')return respond(await submitManual(env,id,await body(req)),201);
  }
  // Phase 2 safety: authenticated inspection and explicit fee-risk authorization.
  const recoveryRoute=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/recovery$/);
  if(recoveryRoute&&req.method==='GET')return respond(await recoveryState(env,recoveryRoute[1]));
  const retryRoute=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/retry$/);
  if(retryRoute&&req.method==='POST')return respond(await authorizeRetry(env,retryRoute[1],await body(req),req.headers.get('Idempotency-Key')),202);
  if(pathname==='/api/jobs/reconcile'&&req.method==='POST')return respond(await reconcileSafe(env));
  const matched=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(advance|review))?$/);
  if(matched){
   const [,id,action]=matched;
   if(req.method==='GET'&&!action)return await detail(env,id);
   if(req.method==='POST'&&action==='advance'){
    // Fail closed: the old synchronous implementation does not maintain
    // persisted paid-call outcome state. Phase 2 only permits safe Queue jobs.
    if(!safeEnabled(env))fail(409,'自動 AI 執行必須明確啟用安全背景工作');
    return respond(await startSafeReview(env,id),202);
   }
   if(req.method==='POST'&&action==='review')return await humanReview(env,id,req);
  }
  return respond({error:'Not Found'},404);
 }catch(err){
  const status=err.status||(err.message?.startsWith('DOCX_')?422:500);
  return respond({error:status===500?'處理失敗':err.message},status);
 }
},
 async queue(batch,env){
  for(const message of batch.messages)await consumeSafeMessage(message,env);
 },
 async scheduled(_event,env){
  // Requires separately configured Cron trigger; never deploys itself.
  if(safeEnabled(env))await reconcileSafe(env);
 }
};
