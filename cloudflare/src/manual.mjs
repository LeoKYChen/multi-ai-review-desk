/** Browser-assisted mode: the user must paste model replies manually. */
import { makePrompt } from './models.mjs';
const phases=['independent','critique','proposal'];
const providers=['chatgpt','gemini'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const insist=(ok,message,status=409)=>{if(!ok)fail(status,message);};
const now=()=>new Date().toISOString();
async function getTask(env,id){
 const t=await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
 insist(t,'找不到任務',404);
 insist(t.mode==='manual','此任務不是網頁版輔助模式');
 return t;
}
async function latestRound(env,taskId){
 return env.DB.prepare('SELECT * FROM task_rounds WHERE task_id=? ORDER BY ordinal DESC LIMIT 1').bind(taskId).first();
}
async function getRows(env,roundId){
 return (await env.DB.prepare('SELECT provider,phase,body FROM ai_outputs WHERE round_id=?').bind(roundId).all()).results;
}
export function nextManualStep(records){
 for(const phase of phases){
  for(const provider of providers)if(!records.some(x=>x.phase===phase&&x.provider===provider))
   return {phase,provider};
 }
 return null;
}
export async function beginManual(env,taskId){
 const task=await getTask(env,taskId);
 insist(['new','needs_rework','failed'].includes(task.status),'此任務目前無法建立新回合');
 const count=await env.DB.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM task_rounds WHERE task_id=?').bind(taskId).first();
 const ordinal=count.n+1,id=crypto.randomUUID(),created=now();
 await env.DB.batch([
  env.DB.prepare('INSERT INTO task_rounds (id,task_id,ordinal,state,created_at) VALUES (?,?,?,?,?)').bind(id,taskId,ordinal,'running',created),
  env.DB.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=? AND status=?").bind(created,taskId,task.status)
 ]);
 return {round_id:id,ordinal,status:'running',mode:'manual'};
}
export async function getManualNext(env,taskId){
 const task=await getTask(env,taskId);
 insist(task.status==='running'||task.status==='awaiting_human','任務尚未開始或已結案');
 const round=await latestRound(env,taskId);
 insist(round,'沒有審查回合');
 const records=await getRows(env,round.id);
 const next=nextManualStep(records);
 if(!next)return {complete:true,round_id:round.id};
 return {complete:false,round_id:round.id,...next,prompt:makePrompt(task,next.phase,next.provider,records,80000)};
}
export async function submitManual(env,taskId,input){
 const task=await getTask(env,taskId);
 insist(task.status==='running','任務目前不能貼入意見');
 insist(input&&typeof input.body==='string'&&input.body.trim().length>0&&input.body.length<=50000,
  '請輸入 1 至 50,000 字的 AI 回覆',422);
 const round=await latestRound(env,taskId);
 insist(round?.state==='running','審查回合不在執行狀態');
 const records=await getRows(env,round.id);
 const step=nextManualStep(records);
 insist(step,'兩位 AI 已完成三階段');
 insist(input.phase===step.phase&&input.provider===step.provider,
  '審查階段已變更，請重新整理畫面');
 const created=now();
 await env.DB.prepare("INSERT INTO ai_outputs (id,round_id,provider,phase,body,created_at,source) VALUES (?,?,?,?,?,?,?)")
  .bind(crypto.randomUUID(),round.id,step.provider,step.phase,input.body.trim(),created,'manual_unverified').run();
 const done=nextManualStep([...records,{provider:step.provider,phase:step.phase}])===null;
 if(done)await env.DB.batch([
  env.DB.prepare("UPDATE task_rounds SET state='awaiting_human' WHERE id=? AND state='running'").bind(round.id),
  env.DB.prepare("UPDATE tasks SET status='awaiting_human',updated_at=? WHERE id=? AND status='running'").bind(created,taskId)
 ]);
 return {saved:true,source:'manual_unverified',completed:done,status:done?'awaiting_human':'running'};
}
