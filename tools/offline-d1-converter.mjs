/** Offline v0.8 backup -> D1 SQL. No network, writes only when CLI explicitly requests output. */
import {createHash} from 'node:crypto';
const phases=['independent','critique','proposal'],providers=['chatgpt','gemini'];
const steps=phases.flatMap(p=>providers.map(w=>[p,w]));
const statuses=new Set(['new','running','awaiting_human','needs_rework','closed']);
const decisions=new Set(['accept_chatgpt','accept_gemini','partial','reject','rework']);
const dateRE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuidRE=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=x=>{throw new Error(x);};
const need=(test,msg)=>{if(!test)fail(msg);};
function bounded(x,msg,min=0,max=50000){
 need(typeof x==='string'&&x.length>=min&&x.length<=max&&!x.includes('\0'),msg+' 無效或超過限制');
 return x;
}
function date(x,msg){
 need(typeof x==='string'&&dateRE.test(x)&&!Number.isNaN(Date.parse(x))&&new Date(x).toISOString()===x,msg+' 格式無效');
 return x;
}
function chronological(a,b,msg){need(a<=b,msg+' 時間順序不合法');}
function derivedId(kind,input){
 const b=createHash('sha256').update('multi-ai-offline-d1-v0.9\0'+kind+'\0'+input).digest().subarray(0,16);
 b[6]=(b[6]&15)|128;b[8]=(b[8]&63)|128; // UUIDv8; stable custom hash, not UUIDv5
 const h=b.toString('hex');
 return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}
export function taskId(id){
 bounded(id,'原始任務 ID',1,100);
 return uuidRE.test(id)?id.toLowerCase():derivedId('task',id);
}
const quoted=x=>x===null?'NULL':"'"+String(x).replace(/'/g,"''")+"'";
function insert(table,columns,vals){
 return 'INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+vals.map(quoted).join(',')+');';
}
export function validateBackup(b){
 need(obj(b)&&b.version===8&&Array.isArray(b.tasks)&&b.tasks.length<=100&&
   (b.format===undefined||b.format==='multi-ai-offline-v0.8'),'只接受最多 100 筆任務的 v0.8 JSON');
 const seen=new Set(),mapped=new Set(),tasks=[];
 const counts={tasks:0,rounds:0,outputs:0,reviews:0};
 for(const [i,t] of b.tasks.entries()){
  const label='第 '+(i+1)+' 筆任務';
  need(obj(t)&&statuses.has(t.status)&&Array.isArray(t.rounds)&&t.rounds.length<=30,label+' 結構無效');
  const original=bounded(t.id,label+' ID',1,100),id=taskId(original);
  need(!seen.has(original)&&!mapped.has(id),label+' ID 重複');
  seen.add(original);mapped.add(id);
  const title=bounded(t.title,label+' 標題',1,180);
  const instruction=bounded(t.instruction,label+' 指令',1,20000);
  const document_text=bounded(t.documentText,label+' 文件文字',0,50000);
  const document_name=bounded(t.documentName??'',label+' Word 名稱',0,180)||null;
  const category=bounded(t.category??'一般',label+' 分類',1,30);
  const created_at=date(t.createdAt,label+' 建立時間');
  const updated_at=date(t.updatedAt,label+' 更新時間');
  chronological(created_at,updated_at,label);
  need((t.status==='new')===(t.rounds.length===0),label+' 任務狀態與回合不一致');
  const rounds=[];let previous=created_at;
  for(const [j,r] of t.rounds.entries()){
   const where=label+' 第 '+(j+1)+' 回合';
   need(obj(r)&&r.ordinal===j+1&&Array.isArray(r.outputs)&&r.outputs.length<=6,where+' 結構不合法');
   const rid=derivedId('round',id+'/'+(j+1)),started_at=date(r.startedAt,where+' 開始時間');
   chronological(previous,started_at,where);
   let last=started_at;const outputs=[];
   for(const [k,o] of r.outputs.entries()){
    const [phase,provider]=steps[k];
    need(obj(o)&&o.phase===phase&&o.provider===provider&&
     (o.source===undefined||o.source==='manual_unverified'),where+' 第 '+(k+1)+' 份意見順序／來源錯誤');
    const body=bounded(o.body,where+' 意見',1,50000),created_at=date(o.createdAt,where+' 意見時間');
    chronological(last,created_at,where);last=created_at;
    outputs.push({id:derivedId('output',rid+'/'+k),round_id:rid,phase,provider,body,created_at,source:'manual_unverified'});
    counts.outputs++;
   }
   let review=null;
   if(r.review!==null&&r.review!==undefined){
    need(obj(r.review)&&decisions.has(r.review.decision)&&outputs.length===6,where+' 人工決定無效');
    const note=bounded(r.review.note,where+' 核定理由',0,10000);
    need(r.review.decision!=='rework'||note.trim().length>0,where+' 退回須具體理由');
    const created_at=date(r.review.createdAt,where+' 核定時間');
    chronological(last,created_at,where);last=created_at;
    review={id:derivedId('review',rid),round_id:rid,decision:r.review.decision,note,created_at};
    counts.reviews++;
   }
   const state=review?(review.decision==='rework'?'needs_rework':'closed'):
    (outputs.length===6?'awaiting_human':'running');
   if(j<t.rounds.length-1)need(state==='needs_rework',where+' 尚未退回卻建立下一回合');
   else need(state===t.status,where+' 與任務狀態不一致');
   rounds.push({id:rid,task_id:id,ordinal:j+1,state,created_at:started_at,outputs,review});
   counts.rounds++;previous=last;
  }
  chronological(previous,updated_at,label);
  tasks.push({id,title,instruction,document_text,document_name,status:t.status,mode:'manual',category,
   created_at,updated_at,rounds});
  counts.tasks++;
 }
 return {tasks,counts};
}
export function convertToSql(backup){
 const {tasks,counts}=validateBackup(backup);
 const lines=[
  '-- SQLITE-ONLY TEST PREVIEW. DO NOT RUN USING WRANGLER AGAINST REMOTE D1.',
  '-- Created from an offline v0.8 backup. Contains PRIVATE plaintext. Keep local.',
  '-- Needs D1 migrations 0001-0005. Duplicate primary keys ABORT, never overwrite.',
  'PRAGMA foreign_keys=ON;','BEGIN IMMEDIATE;'
 ];
 for(const t of tasks){
  lines.push(insert('tasks',['id','title','instruction','document_text','document_name','status','created_at','updated_at','mode','category'],
    [t.id,t.title,t.instruction,t.document_text,t.document_name,t.status,t.created_at,t.updated_at,t.mode,t.category]));
  for(const r of t.rounds){
   lines.push(insert('task_rounds',['id','task_id','ordinal','state','created_at'],
     [r.id,r.task_id,r.ordinal,r.state,r.created_at]));
   for(const o of r.outputs){
    lines.push(insert('ai_outputs',['id','round_id','provider','phase','body','created_at','source'],
      [o.id,o.round_id,o.provider,o.phase,o.body,o.created_at,o.source]));
   }
   if(r.review)lines.push(insert('human_decisions',['id','round_id','decision','note','created_at'],
     [r.review.id,r.review.round_id,r.review.decision,r.review.note,r.review.created_at]));
  }
 }
 lines.push('COMMIT;','');
 return {sql:lines.join('\n'),counts};
}

/**
 * Canonical, offline import preview. Records contain the full text!
 * Future D1 implementation MUST use an authenticated, atomic D1 batch
 * after a backup; this module itself never writes to a database.
 */
export function convertToPlan(raw){
 const {tasks,counts}=validateBackup(raw);
 const records={tasks:[],task_rounds:[],ai_outputs:[],human_decisions:[]};
 for(const t of tasks){
  const {rounds,...base}=t;records.tasks.push(base);
  for(const r of rounds){
   const {outputs,review,...info}=r;records.task_rounds.push(info);
   records.ai_outputs.push(...outputs);
   if(review)records.human_decisions.push(review);
  }
 }
 return {format:'multi-ai-d1-import-plan-v1',source_format:'multi-ai-offline-v0.8',
  import_policy:'create-only-no-overwrite',verification:'manual_unverified',
  counts,records};
}
