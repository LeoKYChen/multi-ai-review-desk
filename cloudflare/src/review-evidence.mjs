/** Phase 3: traceable critique assertions and human-owned evidence status.
 * Model output is untrusted data. Never trust model-generated IDs or verification.
 */
const uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const bad=(status,msg,code)=>Object.assign(new Error(msg),{status,code});
const one=(db,sql,...values)=>db.prepare(sql).bind(...values).first();
const list=async(db,sql,...values)=>(await db.prepare(sql).bind(...values).all()).results;
const run=(db,sql,...values)=>db.prepare(sql).bind(...values).run();
const isStr=(x,max=50000)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const providers=['chatgpt','gemini'];
export const CRITIQUE_VERSION='objections-v1';
export const CRITIQUE_INSTRUCTIONS=[
 '請先以自然文字提出完整交叉評論，然後另附以下機器可讀區塊：',
 'BEGIN_FEEDBACK_OBJECTIONS',
 '{"objections":[{"target_provider":"chatgpt 或 gemini","quote":"直接從該模型第一階段初評複製的原句","reason":"具體異議理由"}]}',
 'END_FEEDBACK_OBJECTIONS',
 '如果確定完全沒有異議，仍須輸出 {"objections":[]}。',
 '每項 quote 必須是對方或自己的獨立初稿逐字原句，不可捏造引文。',
 '請不要填寫資料庫 ID；不要宣稱已完成查證或核定。'
].join('\n');

/** Locate quoted text in the immutable original, using JS UTF-16 offsets.
 * Ambiguously repeated quotes degrade to whole-output reference. */
export function locateQuote(text,quote){
 const at=text.indexOf(quote);
 if(at<0)return null;
 if(text.indexOf(quote,at+1)>=0)return {anchor_kind:'whole',quoted_text:quote,start_offset:null,end_offset:null,ambiguous:true};
 return {anchor_kind:quote.includes('\n')?'paragraph':'sentence',quoted_text:quote,start_offset:at,end_offset:at+quote.length,ambiguous:false};
}
export function parseCritiqueText(body,records){
 if(typeof body!=='string'||body.length>50000)return {valid:false,error:'EMPTY_OR_OVERSIZED',items:[]};
 const matches=[...body.matchAll(/BEGIN_FEEDBACK_OBJECTIONS\s*([\s\S]*?)\s*END_FEEDBACK_OBJECTIONS/g)];
 if(matches.length!==1)return {valid:false,error:'MISSING_OR_DUPLICATED_STRUCTURE',items:[]};
 let obj;
 try{obj=JSON.parse(matches[0][1]);}catch{return {valid:false,error:'INVALID_JSON',items:[]};}
 if(!obj||!Array.isArray(obj.objections)||obj.objections.length>50)return {valid:false,error:'INVALID_OBJECTION_LIST',items:[]};
 const items=[];
 for(const entry of obj.objections){
  if(!entry||!providers.includes(entry.target_provider)||!isStr(entry.quote,2000)||!isStr(entry.reason,10000))
   return {valid:false,error:'INVALID_OBJECTION_FIELDS',items:[]};
  const target=records.find(x=>x.phase==='independent'&&x.provider===entry.target_provider);
  if(!target?.id||typeof target.body!=='string')return {valid:false,error:'NO_TARGET_OUTPUT',items:[]};
  const anchor=locateQuote(target.body,entry.quote);
  if(!anchor)return {valid:false,error:'QUOTE_NOT_IN_ORIGINAL',items:[]};
  items.push({...anchor,target_output_id:target.id,objection_text:entry.reason.trim(),target_provider:entry.target_provider});
 }
 return {valid:true,error:null,items};
}
export function critiqueStatements(db,{body,outputId,roundId,records,createdAt=now()}){
 const parsed=parseCritiqueText(body,records);
 const statements=[
  db.prepare("INSERT INTO critique_parse_status(ai_output_id,status,error_code,checked_at) VALUES(?,?,?,?)")
   .bind(outputId,parsed.valid?'valid':'needs_human',parsed.error,createdAt)
 ];
 if(parsed.valid)for(const item of parsed.items){
  statements.push(db.prepare("INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .bind(uuid(),roundId,outputId,item.target_output_id,'ai',item.anchor_kind,item.quoted_text,item.start_offset,item.end_offset,item.objection_text,createdAt));
 }
 return {statements,parse_status:parsed.valid?'valid':'needs_human',error:parsed.error};
}
export async function allCritiquesValidated(env,roundId){
 const rows=await list(env.DB,"SELECT a.id, p.status FROM ai_outputs a LEFT JOIN critique_parse_status p ON p.ai_output_id=a.id WHERE a.round_id=? AND a.phase='critique'",roundId);
 return rows.length===2&&rows.every(x=>x.status==='valid'||x.status==='resolved');
}
async function requireTask(env,taskId){
 if(!await one(env.DB,'SELECT id FROM tasks WHERE id=?',taskId))throw bad(404,'找不到任務');
}
async function roundInTask(env,taskId,roundId){
 const round=await one(env.DB,'SELECT * FROM task_rounds WHERE id=? AND task_id=?',roundId,taskId);
 if(!round)throw bad(404,'找不到此任務的審查回合');
 return round;
}
async function outputInRound(env,roundId,outputId){
 const output=await one(env.DB,'SELECT * FROM ai_outputs WHERE id=? AND round_id=?',outputId,roundId);
 if(!output)throw bad(422,'引用的 AI 原文不屬於此回合');
 return output;
}
function checkAnchor(body,input){
 const kind=input.anchor_kind||'whole',quote=input.quoted_text||'';
 if(!['sentence','paragraph','whole'].includes(kind))throw bad(422,'異議定位類型不正確');
 if(kind==='whole')return {kind,quote:typeof quote==='string'?quote:'',start:null,end:null};
 if(!isStr(quote,2000))throw bad(422,'精確定位需要原文引用');
 const at=locateQuote(body,quote);
 if(!at||at.ambiguous||at.anchor_kind!==kind)throw bad(422,'引文不存在或無法唯一定位，請改用整份評論定位');
 return {kind,quote,start:at.start_offset,end:at.end_offset};
}
async function originalAndEvents(env,taskId,roundId){
 await roundInTask(env,taskId,roundId);
 const rows=await list(env.DB,'SELECT * FROM review_objections WHERE round_id=? ORDER BY created_at,id',roundId);
 const result=[];
 for(const row of rows){
  const events=await list(env.DB,'SELECT * FROM objection_events WHERE objection_id=? ORDER BY next_revision',row.id);
  const view={...row,revision:0,review_status:'pending',lineage_ids:[]};
  for(const e of events){
   const detail=JSON.parse(e.details_json);
   if(detail.patch)Object.assign(view,detail.patch);
   if(detail.review_status)view.review_status=detail.review_status;
   view.revision=e.next_revision;
  }
  const linked=await list(env.DB,'SELECT parent_objection_id,child_objection_id,relation FROM objection_relations WHERE parent_objection_id=? OR child_objection_id=?',row.id,row.id);
  view.lineage_ids=linked;
  result.push(view);
 }
 return result;
}
export async function getObjections(env,taskId,roundId){
 const items=await originalAndEvents(env,taskId,roundId);
 const statuses=await list(env.DB,"SELECT a.id,a.provider,p.status,p.error_code FROM ai_outputs a LEFT JOIN critique_parse_status p ON a.id=p.ai_output_id WHERE a.round_id=? AND a.phase='critique'",roundId);
 return {task_id:taskId,round_id:roundId,items,parse_statuses:statuses};
}
export async function createHumanObjection(env,taskId,input){
 const roundId=input?.round_id;await roundInTask(env,taskId,roundId);
 if(!isStr(input.objection_text,10000))throw bad(422,'請輸入具體異議理由');
 const target=await outputInRound(env,roundId,input.target_output_id);
 const anchor=checkAnchor(target.body,input),id=uuid(),stamp=now();
 await run(env.DB,"INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at) VALUES(?,?,NULL,?,'human',?,?,?,?,?,?)",
  id,roundId,target.id,anchor.kind,anchor.quote,anchor.start,anchor.end,input.objection_text.trim(),stamp);
 return {id,round_id:roundId,origin:'human'};
}
export async function correctObjection(env,taskId,objectionId,input){
 const original=await one(env.DB,'SELECT o.* FROM review_objections o JOIN task_rounds r ON r.id=o.round_id WHERE o.id=? AND r.task_id=?',objectionId,taskId);
 if(!original)throw bad(404,'找不到異議');
 const view=(await originalAndEvents(env,taskId,original.round_id)).find(x=>x.id===objectionId);
 if(!Number.isInteger(input?.expected_revision)||view.revision!==input.expected_revision)
  throw bad(409,'異議內容已更新，請重新讀取最新版本','OBJECTION_REVISION_CONFLICT');
 const action=input.action||'correct';
 if(!['correct','annotate','resolve'].includes(action))throw bad(422,'異議處理方式不支援');
 const patch={},value=input.objection_text;
 if(value!==undefined){if(!isStr(value,10000))throw bad(422,'異議理由無效');patch.objection_text=value.trim();}
 if(input.anchor_kind!==undefined||input.quoted_text!==undefined){
  const target=await outputInRound(env,original.round_id,original.target_output_id);
  const anchor=checkAnchor(target.body,{anchor_kind:input.anchor_kind||view.anchor_kind,
   quoted_text:input.quoted_text??view.quoted_text});
  Object.assign(patch,{anchor_kind:anchor.kind,quoted_text:anchor.quote,start_offset:anchor.start,end_offset:anchor.end});
 }
 if(!Object.keys(patch).length&&action!=='resolve')throw bad(422,'沒有要修改的內容');
 const event={patch,review_status:action==='resolve'?'resolved':null,
  reason:typeof input.reason==='string'?input.reason.slice(0,5000):''};
 const eventId=uuid(),rev=view.revision+1;
 try{
  await run(env.DB,"INSERT INTO objection_events(id,objection_id,action,actor,prior_revision,next_revision,details_json,created_at) VALUES(?,?,?,'human',?,?,?,?)",
   eventId,objectionId,action,view.revision,rev,JSON.stringify(event),now());
 }catch{throw bad(409,'異議版本衝突，請重新整理','OBJECTION_REVISION_CONFLICT');}
 return {id:objectionId,revision:rev,action};
}
export async function resolveCritique(env,taskId,roundId,outputId){
 await roundInTask(env,taskId,roundId);
 const output=await outputInRound(env,roundId,outputId);
 if(output.phase!=='critique')throw bad(422,'只能確認交叉評論');
 const current=await one(env.DB,'SELECT status FROM critique_parse_status WHERE ai_output_id=?',outputId);
 if(!current||!['needs_human','resolved'].includes(current.status))throw bad(409,'這份評論沒有待處理的解析錯誤');
 if(current.status==='resolved')return {resolved:true,already:true};
 const count=await one(env.DB,'SELECT COUNT(*) AS n FROM review_objections WHERE source_critique_output_id=?',outputId);
 // Allow explicit human confirmation of an empty objection list. The review
 // assistant cannot infer this from invalid JSON on its own.
 await run(env.DB,"UPDATE critique_parse_status SET status='resolved',error_code=NULL,checked_at=? WHERE ai_output_id=? AND status='needs_human'",now(),outputId);
 return {resolved:true,objections_count:count.n,requires_owner_ack:true};
}
export async function listSources(env,taskId){
 await requireTask(env,taskId);
 return {task_id:taskId,items:await list(env.DB,'SELECT * FROM source_checks WHERE task_id=? ORDER BY updated_at DESC,id',taskId)};
}
export async function createSource(env,taskId,input){
 await requireTask(env,taskId);
 if(!isStr(input?.claim_text)||!['verified','pending','model_inference'].includes(input.status))
  throw bad(422,'查證主張或狀態無效');
 const status=input.status,label=typeof input.source_label==='string'?input.source_label.trim():'';
 if(label.length>500||(input.source_uri&&!/^https?:\/\//i.test(input.source_uri)))
  throw bad(422,'來源名稱過長或網址格式不正確');
 if(status==='verified'&&(!label.trim()||!isStr(input.evidence_note,5000)))
  throw bad(422,'已查證必須有具體來源及人工核對紀錄');
 const id=uuid(),stamp=now();
 const ai=input.related_ai_output_id||null,ob=input.related_objection_id||null;
 try{
  await env.DB.batch([
   env.DB.prepare("INSERT INTO source_checks(id,task_id,related_ai_output_id,related_objection_id,claim_text,source_label,source_uri,source_locator,status,verified_by,verified_at,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)")
    .bind(id,taskId,ai,ob,input.claim_text.trim(),label,input.source_uri||null,input.source_locator||null,status,status==='verified'?'human':null,status==='verified'?stamp:null,stamp),
   env.DB.prepare("INSERT INTO source_check_events(id,source_check_id,previous_status,new_status,actor,evidence_note,created_at) VALUES(?,?,NULL,?,'human',?,?)")
    .bind(uuid(),id,status,input.evidence_note||'',stamp)
  ]);
 }catch{throw bad(422,'來源與原始模型意見關聯不符，或資料驗證失敗');}
 return {id,task_id:taskId,status,revision:0};
}
export async function updateSource(env,taskId,sourceId,input){
 const db=env.DB,old=await one(db,'SELECT * FROM source_checks WHERE id=? AND task_id=?',sourceId,taskId);
 if(!old)throw bad(404,'找不到來源紀錄');
 if(!Number.isInteger(input?.expected_revision)||!['verified','pending','model_inference'].includes(input.status))
  throw bad(422,'請提供版本與查證狀態');
 const label=typeof input.source_label==='string'?input.source_label.trim():old.source_label;
 const uri=input.source_uri===undefined?old.source_uri:input.source_uri;
 const locator=input.source_locator===undefined?old.source_locator:input.source_locator;
 if(label.length>500||(uri!==null&&(typeof uri!=='string'||uri.length>2048))||
    (locator!==null&&(typeof locator!=='string'||locator.length>1000)))
  throw bad(422,'來源名稱、網址或定位資訊過長');
 if(uri&&!/^https?:\/\//i.test(uri))throw bad(422,'來源網址僅接受 HTTP 或 HTTPS');
 if(input.status==='verified'&&(!label||!isStr(input.evidence_note,5000)))
  throw bad(422,'已核對需要實際來源與人工核對紀錄');
 const stamp=now();
 const result=await db.batch([
  db.prepare("UPDATE source_checks SET status=?,source_label=?,source_uri=?,source_locator=?,verified_by=?,verified_at=?,revision=revision+1,updated_at=? WHERE id=? AND task_id=? AND revision=?")
   .bind(input.status,label,uri,locator,input.status==='verified'?'human':null,input.status==='verified'?stamp:null,stamp,sourceId,taskId,input.expected_revision),
  db.prepare("INSERT INTO source_check_events(id,source_check_id,previous_status,new_status,actor,evidence_note,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1")
   .bind(uuid(),sourceId,old.status,input.status,'human',input.evidence_note||'',stamp)
 ]);
 if((result[0].meta?.changes??0)!==1)throw bad(409,'來源紀錄版本衝突','SOURCE_VERSION_CONFLICT');
 return {id:sourceId,status:input.status,revision:input.expected_revision+1};
}


/** Merge two or more same-round/same-target objections into a new HUMAN
 * interpretation. Never delete, repurpose or change source AI entries. */
export async function mergeObjections(env,taskId,input){
 const ids=Array.isArray(input?.objection_ids)?[...new Set(input.objection_ids)]:[];
 if(ids.length<2||ids.length>20||!isStr(input.objection_text,10000))
  throw bad(422,'至少選擇兩項異議並說明整併內容');
 const roundId=input.round_id,items=await originalAndEvents(env,taskId,roundId);
 const selected=ids.map(id=>items.find(x=>x.id===id));
 if(selected.some(x=>!x)||new Set(selected.map(x=>x.target_output_id)).size!==1)
  throw bad(422,'只能合併同一回合、同一原始 AI 目標的異議');
 const target=selected[0].target_output_id,newId=uuid(),stamp=now(),DB=env.DB;
 const statements=[DB.prepare("INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at) VALUES(?,?,NULL,?,'human','whole','',NULL,NULL,?,?)")
  .bind(newId,roundId,target,input.objection_text.trim(),stamp)];
 for(const row of selected){
  statements.push(DB.prepare("INSERT INTO objection_relations(parent_objection_id,child_objection_id,relation) VALUES(?,?,'merge')").bind(row.id,newId));
  statements.push(DB.prepare("INSERT INTO objection_events(id,objection_id,action,actor,prior_revision,next_revision,details_json,created_at) VALUES(?,?,'merge','human',?,?,?,?)")
   .bind(uuid(),row.id,row.revision,row.revision+1,JSON.stringify({merged_into:newId,reason:(input.reason||'').slice(0,2000)}),stamp));
 }
 try{await DB.batch(statements);}
 catch{throw bad(409,'異議合併衝突，請重新整理','OBJECTION_REVISION_CONFLICT');}
 return {id:newId,origin:'human',merged_from:ids};
}
/** Split one source objection into separate human assertions, preserving the
 * parent and making each derived assertion refer to the original model output. */
export async function splitObjection(env,taskId,objectionId,input){
 const parent=await one(env.DB,"SELECT o.* FROM review_objections o JOIN task_rounds r ON r.id=o.round_id WHERE o.id=? AND r.task_id=?",objectionId,taskId);
 if(!parent)throw bad(404,'找不到原始異議');
 const current=(await originalAndEvents(env,taskId,parent.round_id)).find(x=>x.id===objectionId);
 const parts=input?.items;
 if(!Array.isArray(parts)||parts.length<2||parts.length>20)
  throw bad(422,'請提供至少兩項拆分異議');
 if(!Number.isInteger(input.expected_revision)||current.revision!==input.expected_revision)
  throw bad(409,'異議已更新，請重新整理');
 const target=await outputInRound(env,parent.round_id,parent.target_output_id);
 const DB=env.DB,stamp=now(),children=[],statements=[];
 for(const part of parts){
  if(!isStr(part?.objection_text,10000))throw bad(422,'拆分項目理由無效');
  const a=checkAnchor(target.body,part),id=uuid();children.push(id);
  statements.push(DB.prepare("INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at) VALUES(?,?,NULL,?,'human',?,?,?,?,?,?)")
   .bind(id,parent.round_id,parent.target_output_id,a.kind,a.quote,a.start,a.end,part.objection_text.trim(),stamp));
  statements.push(DB.prepare("INSERT INTO objection_relations(parent_objection_id,child_objection_id,relation) VALUES(?,?,'split')").bind(objectionId,id));
 }
 statements.push(DB.prepare("INSERT INTO objection_events(id,objection_id,action,actor,prior_revision,next_revision,details_json,created_at) VALUES(?,?,'split','human',?,?,?,?)")
  .bind(uuid(),objectionId,current.revision,current.revision+1,JSON.stringify({children,reason:typeof input.reason==='string'?input.reason.slice(0,2000):''}),stamp));
 try{await DB.batch(statements);}
 catch{throw bad(409,'拆分過程有衝突，未修改原始資料','OBJECTION_REVISION_CONFLICT');}
 return {source_id:objectionId,children,source_revision:current.revision+1};
}
