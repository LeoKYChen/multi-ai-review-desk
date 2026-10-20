/** Cloudflare Worker API prototype: D1-only, no R2, no external AI auto-execution. */
import { extractDocxText, MAX_DOCX_BYTES } from './docx.mjs';

const jsonHeaders={
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
};
const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:jsonHeaders});
const iso=()=>new Date().toISOString();
const uuid=()=>crypto.randomUUID();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const assert=(ok,status,message)=>{if(!ok)fail(status,message);};

function validateText(value,max=20000){return typeof value==='string' && value.length<=max;}
function auth(req,env){
  assert(typeof env.OWNER_TOKEN==='string'&&env.OWNER_TOKEN.length>=32,503,'尚未設定有效的 OWNER_TOKEN');
  assert(req.headers.get('Authorization')===`Bearer ${env.OWNER_TOKEN}`,401,'未授權');
}
function sameOrigin(req){
  const origin=req.headers.get('Origin');
  if(origin)assert(origin===new URL(req.url).origin,403,'跨來源要求已拒絕');
}
async function requireJson(req){
  assert(req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'),415,'請提供 application/json');
  assert(Number(req.headers.get('Content-Length')||0)<110000,413,'內容過大');
  const value=await req.text();
  assert(value.length<110000,413,'內容過大');
  try{return JSON.parse(value);}catch{fail(400,'JSON 格式錯誤');}
}
async function taskOr404(env,id){
  const row=await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
  assert(!!row,404,'找不到任務');
  return row;
}
async function createTask(req,env){
  assert((req.headers.get('Content-Type')||'').startsWith('multipart/form-data'),415,'請使用 multipart/form-data');
  assert(Number(req.headers.get('Content-Length')||0) < MAX_DOCX_BYTES+100000,413,'附件過大');
  const form=await req.formData();
  const title=form.get('title'),instruction=form.get('instruction'),file=form.get('document');
  assert(typeof title==='string'&&title.trim().length>0&&title.length<=180,422,'任務標題無效');
  assert(typeof instruction==='string'&&instruction.trim().length>0&&instruction.length<=20000,422,'交辦指令無效');
  let documentText='',documentName=null,warnings=[];
  if(file!==null){
    assert(typeof file!=='string'&&typeof file.arrayBuffer==='function',422,'附件格式錯誤');
    assert(/^.{1,180}\.docx$/i.test(file.name),422,'第一版僅接受 .docx 格式');
    assert(file.size>0&&file.size<=MAX_DOCX_BYTES,413,'Word 檔案不得超過 3 MB');
    const extracted=extractDocxText(new Uint8Array(await file.arrayBuffer()));
    documentText=extracted.text;
    documentName=file.name;
    warnings=extracted.warnings;
  }
  const id=uuid(),time=iso();
  await env.DB.prepare('INSERT INTO tasks (id,title,instruction,document_text,document_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id,title.trim(),instruction.trim(),documentText,documentName,'new',time,time).run();
  return respond({id,title:title.trim(),status:'new',document_name:documentName,extracted_characters:documentText.length,warnings},201);
}
async function taskDetail(env,id){
  const task=await taskOr404(env,id);
  const rounds=(await env.DB.prepare('SELECT * FROM task_rounds WHERE task_id=? ORDER BY ordinal').bind(id).all()).results;
  const result=[];
  for(const round of rounds){
    const outputs=(await env.DB.prepare('SELECT provider,phase,body,created_at FROM ai_outputs WHERE round_id=? ORDER BY created_at').bind(round.id).all()).results;
    const review=await env.DB.prepare('SELECT decision,note,created_at FROM human_decisions WHERE round_id=?').bind(round.id).first();
    result.push({...round,outputs,review});
  }
  return respond({...task,rounds:result});
}
async function createRound(env,taskId){
  const task=await taskOr404(env,taskId);
  assert(['new','needs_rework','failed'].includes(task.status),409,'任務尚不可建立新審查回合');
  const max=await env.DB.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM task_rounds WHERE task_id=?').bind(taskId).first();
  const ordinal=max.n+1,id=uuid(),time=iso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO task_rounds (id,task_id,ordinal,state,created_at) VALUES (?,?,?,?,?)').bind(id,taskId,ordinal,'running',time),
    env.DB.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").bind(time,taskId)
  ]);
  return respond({round_id:id,ordinal,status:'running',notice:'僅建立工作回合；真實 AI 連線尚待整合，並未自動啟動 AI。'},201);
}
const phaseOrder=['independent','critique','proposal'];
async function addOutput(env,roundId,req){
  const input=await requireJson(req);
  assert(input&&['chatgpt','gemini'].includes(input.provider)&&phaseOrder.includes(input.phase)&&
    validateText(input.body,50000)&&input.body.trim().length>0,422,'AI 訊息資料不正確');
  const round=await env.DB.prepare('SELECT * FROM task_rounds WHERE id=?').bind(roundId).first();
  assert(round?.state==='running',409,'此工作回合無法收錄 AI 意見');
  const task=await taskOr404(env,round.task_id);
  assert(task.status==='running',409,'任務不是執行狀態');
  const records=(await env.DB.prepare('SELECT provider,phase FROM ai_outputs WHERE round_id=?').bind(roundId).all()).results;
  const index=phaseOrder.indexOf(input.phase);
  if(index>0){
    const previous=phaseOrder[index-1];
    assert(records.filter(x=>x.phase===previous).length===2,409,'上一階段的兩個 AI 尚未完成');
  }
  assert(!records.some(x=>x.provider===input.provider&&x.phase===input.phase),409,'已有該 AI 的相同階段意見，不得覆蓋');
  const time=iso();
  await env.DB.prepare('INSERT INTO ai_outputs (id,round_id,provider,phase,body,created_at) VALUES (?,?,?,?,?,?)')
    .bind(uuid(),roundId,input.provider,input.phase,input.body.trim(),time).run();
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_outputs WHERE round_id=? AND phase='proposal'").bind(roundId).first();
  if(count.n===2){
    await env.DB.batch([
      env.DB.prepare("UPDATE task_rounds SET state='awaiting_human' WHERE id=?").bind(roundId),
      env.DB.prepare("UPDATE tasks SET status='awaiting_human',updated_at=? WHERE id=?").bind(time,round.task_id)
    ]);
  }
  return respond({accepted:true,phase:input.phase,provider:input.provider,awaiting_human:count.n===2},201);
}
async function humanReview(env,taskId,req){
  const input=await requireJson(req);
  assert(input&&['accept_chatgpt','accept_gemini','partial','reject','rework'].includes(input.decision)&&validateText(input.note,10000),422,'人工決定資料不正確');
  const task=await taskOr404(env,taskId);
  assert(task.status==='awaiting_human',409,'需兩位 AI 各自提出修正建議後，才能人工核定');
  const round=await env.DB.prepare('SELECT * FROM task_rounds WHERE task_id=? ORDER BY ordinal DESC LIMIT 1').bind(taskId).first();
  assert(round?.state==='awaiting_human',409,'工作回合未完成');
  const time=iso(),newStatus=input.decision==='rework'?'needs_rework':'closed';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO human_decisions (id,round_id,decision,note,created_at) VALUES (?,?,?,?,?)').bind(uuid(),round.id,input.decision,input.note??'',time),
    env.DB.prepare('UPDATE task_rounds SET state=? WHERE id=?').bind(newStatus,round.id),
    env.DB.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').bind(newStatus,time,taskId)
  ]);
  return respond({status:newStatus,decision:input.decision,human_reviewed:true});
}
export default {
 async fetch(req,env){
  try{
    assert(env?.DB,503,'D1 資料庫尚未設定');
    sameOrigin(req);
    auth(req,env);
    const url=new URL(req.url),p=url.pathname;
    if(req.method==='GET'&&p==='/api/health')return respond({ok:true,storage:'D1',attachments:'no-raw-files',ai_connections:'not-configured'});
    if(req.method==='POST'&&p==='/api/tasks')return await createTask(req,env);
    if(req.method==='GET'&&p==='/api/tasks'){
      const rows=(await env.DB.prepare('SELECT id,title,status,document_name,created_at FROM tasks ORDER BY created_at DESC LIMIT 100').all()).results;
      return respond({tasks:rows});
    }
    const detail=p.match(/^\/api\/tasks\/([a-f0-9-]{36})$/);
    if(req.method==='GET'&&detail)return await taskDetail(env,detail[1]);
    const round=p.match(/^\/api\/tasks\/([a-f0-9-]{36})\/rounds$/);
    if(req.method==='POST'&&round)return await createRound(env,round[1]);
    const output=p.match(/^\/api\/rounds\/([a-f0-9-]{36})\/outputs$/);
    if(req.method==='POST'&&output)return await addOutput(env,output[1],req);
    const review=p.match(/^\/api\/tasks\/([a-f0-9-]{36})\/review$/);
    if(req.method==='POST'&&review)return await humanReview(env,review[1],req);
    return respond({error:'Not Found'},404);
  }catch(err){
    const status=err.status||(err.message?.startsWith('DOCX_')?422:500);
    return respond({error:status===500?'處理失敗':err.message},status);
  }
 }
};
