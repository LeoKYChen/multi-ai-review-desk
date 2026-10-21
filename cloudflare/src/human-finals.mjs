/** Phase 4: owner-authored drafts, immutable multi-version approvals.
 * Never invokes AI or enqueues a job. */
const uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const err=(status,message,code)=>Object.assign(new Error(message),{status,code});
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
async function getTask(env,id){
 const t=await first(env.DB,'SELECT id,status,mode FROM tasks WHERE id=?',id);
 if(!t)throw err(404,'找不到任務');
 return t;
}
const decisions=['accept_chatgpt','accept_gemini','partial','reject','manual_revision'];
export async function getDraft(env,taskId){
 await getTask(env,taskId);
 return (await first(env.DB,'SELECT * FROM human_drafts WHERE task_id=?',taskId))||
 {task_id:taskId,body:'',revision:0,base_final_id:null,updated_at:null};
}
export async function putDraft(env,taskId,input){
 const t=await getTask(env,taskId);
 if(!['awaiting_human','closed'].includes(t.status))throw err(409,'尚未進入人工核定階段');
 if(typeof input?.body!=='string'||input.body.length>100000||
    !Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)
  throw err(422,'草稿或版本無效');
 const db=env.DB,stamp=now(),existing=await first(db,'SELECT revision FROM human_drafts WHERE task_id=?',taskId);
 let result;
 if(!existing){
  if(input.expected_revision!==0)throw err(409,'草稿版本衝突','DRAFT_VERSION_CONFLICT');
  try{result=await run(db,'INSERT INTO human_drafts(task_id,body,revision,updated_at) VALUES(?,?,1,?)',taskId,input.body,stamp);}
  catch{throw err(409,'草稿已由另一裝置建立，請比較','DRAFT_VERSION_CONFLICT');}
 }else{
  result=await run(db,'UPDATE human_drafts SET body=?,revision=revision+1,updated_at=? WHERE task_id=? AND revision=?',
   input.body,stamp,taskId,input.expected_revision);
 }
 if((result.meta?.changes??0)!==1){
  const current=await getDraft(env,taskId);
  throw Object.assign(err(409,'草稿已更新，請比較雲端最新版本','DRAFT_VERSION_CONFLICT'),{
   details:{server_revision:current.revision,server_body:current.body,server_updated_at:current.updated_at}});
 }
 return {task_id:taskId,revision:input.expected_revision+1,updated_at:stamp,cloud_synced:true};
}
export async function listFinals(env,taskId){
 await getTask(env,taskId);
 return {task_id:taskId,items:await all(env.DB,
  'SELECT id,task_id,version_no,parent_version_id,review_round_id,decision,note,approved_at,substr(body,1,180) AS preview FROM final_versions WHERE task_id=? ORDER BY version_no',taskId)};
}
export async function getFinal(env,taskId,id){
 await getTask(env,taskId);
 const row=await first(env.DB,'SELECT * FROM final_versions WHERE task_id=? AND id=?',taskId,id);
 if(!row)throw err(404,'找不到人工核定版本');
 return {...row,verification_at_approval:JSON.parse(row.source_snapshot_json),
  current_verification:await all(env.DB,'SELECT * FROM source_checks WHERE task_id=? ORDER BY updated_at',taskId)};
}
async function digest(x){
 const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));
 return Array.from(new Uint8Array(h),b=>b.toString(16).padStart(2,'0')).join('');
}
const snapshotSql=[
  '(SELECT COALESCE(json_group_array(json_object(',
  "'id',s.id,'claim_text',s.claim_text,'source_label',s.source_label,",
  "'source_uri',s.source_uri,'source_locator',s.source_locator,'status',s.status,",
  "'verified_by',s.verified_by,'verified_at',s.verified_at,'revision',s.revision",
  ")), '[]') FROM source_checks s WHERE s.task_id=?)"
].join(' ');
export async function approveFinal(env,taskId,input,key){
 if(typeof key!=='string'||key.length<12||key.length>160)
  throw err(422,'需要有效的 Idempotency-Key');
 if(!input||!decisions.includes(input.decision)||!Number.isSafeInteger(input.expected_draft_revision)||
    input.expected_draft_revision<1||typeof input.note!=='string'||input.note.length>10000)
  throw err(422,'核定決定、備註或草稿版本無效');
 const sig=await digest(JSON.stringify({
  revision:input.expected_draft_revision,base_final_id:input.base_final_id??null,
  decision:input.decision,note:input.note,acknowledge_unverified:input.acknowledge_unverified===true
 }));
 const DB=env.DB,scope='final:'+taskId;
 const saved=await first(DB,'SELECT request_sha256,response_json FROM mutation_idempotency WHERE scope=? AND request_key=?',scope,key);
 if(saved){
  if(saved.request_sha256!==sig)throw err(409,'Idempotency-Key 不能使用於不同核定內容','IDEMPOTENCY_PAYLOAD_CONFLICT');
  return {...JSON.parse(saved.response_json),duplicate:true};
 }
 const t=await getTask(env,taskId);
 if(!['awaiting_human','closed'].includes(t.status))throw err(409,'任務不在核定階段');
 const draft=await first(DB,'SELECT * FROM human_drafts WHERE task_id=?',taskId);
 if(!draft||draft.revision!==input.expected_draft_revision||!draft.body.trim())
  throw err(409,'草稿已修改或沒有內容','DRAFT_VERSION_CONFLICT');
 const previous=await first(DB,'SELECT id,version_no FROM final_versions WHERE task_id=? ORDER BY version_no DESC LIMIT 1',taskId);
 const parent=previous?.id||null;
 if((input.base_final_id??null)!==parent||draft.base_final_id!==parent)
  throw err(409,'已有新的核定版本，請先比對','FINAL_PARENT_CONFLICT');
 const pending=await first(DB,"SELECT COUNT(*) AS n FROM source_checks WHERE task_id=? AND status<>'verified'",taskId);
 if(pending.n>0&&input.acknowledge_unverified!==true)
  throw err(422,'請確認仍有待查證來源','UNVERIFIED_ACK_REQUIRED');
 const round=t.status==='awaiting_human'?
  await first(DB,'SELECT id,state FROM task_rounds WHERE task_id=? ORDER BY ordinal DESC LIMIT 1',taskId):null;
 if(t.status==='awaiting_human'&&round?.state!=='awaiting_human')
  throw err(409,'雙 AI 回合尚未進入人工核定');
 const version=(previous?.version_no||0)+1,finalId=uuid(),stamp=now();
 const response={id:finalId,task_id:taskId,version_no:version,approved_at:stamp,
  status:'closed',snapshot_unverified_count:pending.n};
 const insertSql=[
  'INSERT INTO final_versions(id,task_id,version_no,parent_version_id,review_round_id,body,decision,note,source_snapshot_json,approved_at)',
  'SELECT ?,d.task_id,?,?,?,d.body,?,?,',snapshotSql,',?',
  'FROM human_drafts d WHERE d.task_id=? AND d.revision=? AND length(trim(d.body))>0',
  'AND (SELECT COALESCE(MAX(f.version_no),0) FROM final_versions f WHERE f.task_id=d.task_id)=?',
  'AND d.base_final_id IS ?'
 ].join(' ');
 const statements=[
  DB.prepare(insertSql).bind(finalId,version,parent,round?.id||null,input.decision,input.note,taskId,stamp,
   taskId,draft.revision,version-1,parent),
  DB.prepare("UPDATE human_drafts SET base_final_id=?,revision=revision+1,updated_at=? WHERE task_id=? AND revision=? AND EXISTS(SELECT 1 FROM final_versions WHERE id=?)")
   .bind(finalId,stamp,taskId,draft.revision,finalId)
 ];
 if(round){
  statements.push(DB.prepare("INSERT INTO human_decisions(id,round_id,decision,note,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM final_versions WHERE id=?) AND NOT EXISTS(SELECT 1 FROM human_decisions WHERE round_id=?)")
   .bind(uuid(),round.id,input.decision==='manual_revision'?'partial':input.decision,input.note,stamp,finalId,round.id));
  statements.push(DB.prepare("UPDATE task_rounds SET state='closed' WHERE id=? AND state='awaiting_human' AND EXISTS(SELECT 1 FROM final_versions WHERE id=?)").bind(round.id,finalId));
 }
 statements.push(DB.prepare("UPDATE tasks SET status='closed',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM final_versions WHERE id=?)").bind(stamp,taskId,finalId));
 statements.push(DB.prepare("INSERT INTO mutation_idempotency(scope,request_key,request_sha256,response_json,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM final_versions WHERE id=?)")
  .bind(scope,key,sig,JSON.stringify(response),stamp,finalId));
 let results;
 try{results=await DB.batch(statements);}
 catch{throw err(409,'核定版本衝突，舊版本未變動','FINAL_VERSION_CONFLICT');}
 if((results[0]?.meta?.changes??0)!==1)throw err(409,'草稿或核定版本已變更','DRAFT_VERSION_CONFLICT');
 return response;
}
