/** Phase 5 browser controller. All AI/evidence text is rendered as textContent.
 * No provider credentials in this module. IndexedDB only stores unsynced text. */
import {draftPayload,readCachedDraft,writeCachedDraft,clearCachedDraft,clearCachedDraftIf,
 detectDraftConflict} from './draft-cache.js';

export function initReviewUi({api,$,showAlert,getActiveTask,reload}){
 const state={taskId:null,roundId:null,serverRevision:0,baseFinalId:null,localEdit:null,
  inflight:false,conflict:null,timer:null,editable:false,cacheQueue:Promise.resolve(),sourceItems:[],objectionItems:[],finalItems:[],recovery:null,approval:null};
 const el=id=>$(id);
 const draft=()=>el('human-draft');
 function info(message){el('draft-state').textContent=message;}
 function item(text,classname){
  const node=document.createElement('div');if(classname)node.className=classname;
  node.textContent=String(text);return node;
 }
 function button(label,fn){
  const node=document.createElement('button');node.type='button';node.className='ghost small';
  node.textContent=label;node.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>showAlert(e.message,true)));
  return node;
 }
 async function cacheText(){
  if(!state.taskId)return;
  const current=draftPayload(state.taskId,draft().value,state.serverRevision);
  state.localEdit=current;info('本機暫存中，尚未同步雲端');
  // Serialize rapid keystrokes so an older async IndexedDB write can never
  // finish after (and overwrite) a newer unsynced version.
  state.cacheQueue=state.cacheQueue.catch(()=>{}).then(()=>writeCachedDraft(current));
  try{await state.cacheQueue;
   if(state.taskId===current.task_id&&state.localEdit?.local_edit_id===current.local_edit_id)
    info('本機已暫存，尚未同步雲端');
  }catch(e){info('本機暫存失敗，請自行備份文字');showAlert(e.message,true);}
 }
 function scheduleSave(){
  clearTimeout(state.timer);
  state.timer=setTimeout(()=>syncDraft().catch(e=>showAlert(e.message,true)),1200);
 }
 function showConflict(server){
  state.conflict={server_revision:server.server_revision,server_body:server.server_body};
  el('draft-conflict').classList.remove('hidden');
  el('draft-server-copy').textContent=server.server_body??'';
  el('draft-local-copy').textContent=draft().value;
  info('版本衝突：未覆寫雲端或本機');
 }
 async function syncDraft(){
  if(!state.taskId||state.inflight||state.conflict||!state.localEdit)return;
  if(typeof navigator!=='undefined'&&!navigator.onLine){info('目前離線：僅本機暫存');return;}
  await state.cacheQueue.catch(()=>{});
  if(!state.taskId||!state.localEdit||state.conflict)return;
  const edit=state.localEdit,taskId=state.taskId;state.inflight=true;info('正在同步雲端草稿');
  try{
   const r=await api('/tasks/'+taskId+'/draft',{method:'PUT',body:{
    body:edit.body,expected_revision:edit.base_revision
   }});
   if(state.taskId!==taskId)return;
   state.serverRevision=r.revision;
   if(state.localEdit?.local_edit_id===edit.local_edit_id){
    await clearCachedDraftIf(edit);state.localEdit=null;info('雲端已保存（版本 '+r.revision+'）');
   }else if(state.localEdit){
    const newer={...state.localEdit,base_revision:r.revision};
    state.localEdit=newer;state.cacheQueue=state.cacheQueue.catch(()=>{}).then(()=>writeCachedDraft(newer));
    await state.cacheQueue;info('部分變更已同步，仍有新的本機修改');
   }
  }catch(e){
   if(state.taskId!==taskId)return;
   if(e.status===409&&e.code==='DRAFT_VERSION_CONFLICT'&&e.details)showConflict(e.details);
   else{info('尚未同步：本機暫存已保留');showAlert('草稿尚未同步：'+e.message,true);}
  }finally{
   state.inflight=false;
   if(state.localEdit&&!state.conflict&&state.localEdit.local_edit_id!==edit.local_edit_id)scheduleSave();
  }
 }
 async function loadDraft(taskId){
  const remote=await api('/tasks/'+taskId+'/draft');
  if(state.taskId!==taskId)return;
  state.serverRevision=remote.revision;state.baseFinalId=remote.base_final_id;
  let cached=null;
  try{cached=await readCachedDraft(taskId);}catch(e){showAlert('本機草稿讀取失敗：'+e.message,true);}
  if(state.taskId!==taskId)return;
  if(cached){
   state.localEdit=cached;draft().value=cached.body;
   if(detectDraftConflict(cached,remote))showConflict({server_revision:remote.revision,server_body:remote.body});
   else{info('找到未同步的本機草稿');scheduleSave();}
  }else{
   draft().value=remote.body;
   info(remote.updated_at?'雲端已保存（版本 '+remote.revision+'）':'尚無草稿，開始編輯後自動保存');
  }
 }
 async function loadFinals(taskId){
  const data=await api('/tasks/'+taskId+'/finals');
  if(state.taskId!==taskId)return;
  state.finalItems=data.items||[];
  const box=el('final-history');box.replaceChildren();
  if(!state.finalItems.length){box.append(item('尚無正式核定版本。','hint'));return;}
  box.append(item('已核定版本（不可修改；核定後可另編新版本）','round-review-title'));
  for(const v of state.finalItems){
   const row=item('','version-entry'),header=document.createElement('header');
   header.append(item('版本 v'+v.version_no+' · '+v.approved_at,'round-review-title'),
    button('查看核定內容與來源快照',async()=>{
     const f=await api('/tasks/'+taskId+'/finals/'+v.id);
     const lines=['【不可覆寫的版本 v'+f.version_no+'】',f.body,'','核定當時來源狀態：'];
     for(const s of f.verification_at_approval||[])lines.push('· '+s.claim_text+'｜'+s.status+'｜'+(s.source_label||'無來源'));
     lines.push('','目前來源狀態：');
     for(const s of f.current_verification||[])lines.push('· '+s.claim_text+'｜'+s.status);
     el('final-reader').textContent=lines.join('\n');
     el('final-reader').classList.remove('hidden');
    }));
   row.append(header,item(v.preview||'（空白）','hint'));box.append(row);
  }
 }
 async function refreshSources(){
  const taskId=state.taskId;if(!taskId)return;
  const result=await api('/tasks/'+taskId+'/source-checks');
  if(state.taskId!==taskId)return;
  state.sourceItems=result.items||[];
  const box=el('sources-list');box.replaceChildren();
  if(!state.sourceItems.length)box.append(item('目前尚無來源紀錄，未經獨立查證的 AI 主張不可直接視為已核對。','hint'));
  for(const s of state.sourceItems){
   const row=item('','version-entry');
   row.append(item(s.claim_text,'round-review-title'),
    item('來源：'+(s.source_label||'待補充')+'｜狀態：'+s.status+'｜版本 '+s.revision,'hint'));
   if(s.status!=='verified')row.append(button('我已親自核對',async()=>{
    const label=s.source_label?.trim()||window.prompt('請填寫你實際查閱的來源名稱：');
    if(!label?.trim())return;
    const reason=window.prompt('請填寫核對依據、來源內容或核對方式：');
    if(!reason?.trim())return;
    await api('/tasks/'+taskId+'/source-checks/'+s.id,{method:'PATCH',body:{
     expected_revision:s.revision,status:'verified',source_label:label.trim(),evidence_note:reason.trim()
    }});
    await refreshSources();showAlert('已記錄由你親自核對的查證結果');
   }));
   box.append(row);
  }
 }
 async function refreshObjections(){
  const taskId=state.taskId,roundId=state.roundId;if(!roundId)return;
  const result=await api('/tasks/'+taskId+'/objections?round_id='+encodeURIComponent(roundId));
  if(state.taskId!==taskId||state.roundId!==roundId)return;
  state.objectionItems=result.items||[];
  const root=el('objections-list');root.replaceChildren();
  for(const parse of result.parse_statuses||[]){
   if(parse.status==='needs_human'){
    const wrapper=item('','version-entry');
    wrapper.append(item(parse.provider+' 交叉評論的結構化異議尚待你確認。原始回覆已保留。','hint'),
     button('我已檢查，確認可繼續',async()=>{
      if(!window.confirm('請確認你已閱讀原始交叉評論、整理必要異議（或確認確實沒有異議）。系統會保留原始內容，並在雙方完成確認後才接續。'))return;
      const r=await api('/tasks/'+taskId+'/objections/resolve-parse',{method:'POST',
       body:{round_id:roundId,ai_output_id:parse.id}});
      showAlert(r.workflow?.resumed?'已接續後續審查':'已確認，等待另一份交叉評論整理');
      await refreshObjections();await refreshRecovery();
     }));
    root.append(wrapper);
   }
  }
  if(!state.objectionItems.length)root.append(item('尚無結構化異議。可以自行新增，或先確認 AI 原文是否確實沒有異議。','hint'));
  for(const o of state.objectionItems){
   const wrapper=item('','version-entry'),header=document.createElement('header');
   const check=document.createElement('input');check.type='checkbox';check.dataset.objectionId=o.id;
   check.className='objection-select';check.style.width='auto';
   const label=document.createElement('label');label.className='inline-check';label.append(check,item((o.origin==='ai'?'AI':'人工')+' 異議｜'+o.anchor_kind));
   header.append(label,button('修正理由',async()=>{
    const text=window.prompt('請輸入你修正後的異議理由：',o.objection_text);
    if(!text?.trim()||text===o.objection_text)return;
    await api('/tasks/'+taskId+'/objections/'+o.id,{method:'PATCH',body:{
     expected_revision:o.revision,action:'correct',objection_text:text,reason:'人工校正異議理由'
    }});
    await refreshObjections();
   }));
   wrapper.append(header,item(o.objection_text,'round-note'),
    item('被質疑原文：'+(o.quoted_text||'整份原始評論')+'｜修改版次 '+o.revision,'hint'));
   wrapper.append(button('將這項異議拆成兩項',async()=>{
    const text=window.prompt('請輸入兩項以上的異議，每一行一項：',o.objection_text+'\n');
    const parts=(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
    if(parts.length<2)return;
    await api('/tasks/'+taskId+'/objections/'+o.id+'/split',{method:'POST',body:{
     expected_revision:o.revision,reason:'人工拆分異議',
     items:parts.map(objection_text=>({anchor_kind:'whole',objection_text}))
    }});
    await refreshObjections();
   }));
   root.append(wrapper);
  }
  const picker=el('objection-target');picker.replaceChildren();
  const task=getActiveTask(),round=task?.rounds?.find(x=>x.id===roundId);
  for(const out of round?.outputs?.filter(o=>o.phase==='independent')||[]){
   const opt=document.createElement('option');opt.value=out.id;
   opt.textContent=out.provider+' 的原始初評';picker.append(opt);
  }
 }
 async function refreshRecovery(){
  const task=getActiveTask();
  if(!task||task.mode!=='api')return;
  const result=await api('/tasks/'+task.id+'/recovery');
  if(state.taskId!==task.id)return;
  state.recovery=result;
  if(['paused_failure','paused_parse'].includes(result.status)){
   el('run-hint').textContent=result.status==='paused_parse'?
    '雙 AI 交叉意見已保留，尚需由你確認異議整理，才能進行下一階段。':
    '背景工作因模型失敗而暫停。已完成成果已保留，請查看下方執行紀錄及重試風險。';
   el('run').disabled=true;
  }
  el('recovery-summary').textContent='工作狀態：'+result.status+
   (result.reason_code?'｜原因：'+result.reason_code:'')+
   (result.risk_warning?'｜'+result.risk_warning:'');
  const box=el('recovery-attempts');box.replaceChildren();
  for(const a of result.attempts||[])box.append(item(a.provider+' · '+a.phase+' · '+a.state+
   (a.potential_additional_charge?'｜可能產生費用':''),'hint'));
  const form=el('retry-form');form.classList.toggle('hidden',!(result.allowed_actions||[]).includes('retry_missing_after_ack'));
  const select=el('retry-target');select.replaceChildren();
  const finished=new Set((result.persisted_outputs||[]).map(x=>x.provider+':'+x.phase));
  for(const a of result.attempts||[]){
   const k=a.provider+':'+a.phase;
   if(finished.has(k)||[...select.options].some(x=>x.value===k))continue;
   const opt=document.createElement('option');opt.value=k;opt.textContent=a.provider+' · '+a.phase+' · '+a.state;select.append(opt);
  }
 }
 async function show(task){
  const newTask=state.taskId!==task.id;
  const newestRound=task.rounds?.at(-1)?.id||null;
  const newRound=state.roundId!==newestRound;
  if(newTask){
   clearTimeout(state.timer);
   Object.assign(state,{taskId:task.id,roundId:newestRound,editable:false,
    localEdit:null,serverRevision:0,baseFinalId:null,conflict:null,approval:null});
   el('draft-conflict').classList.add('hidden');
   el('final-reader').classList.add('hidden');
  }else if(newRound)state.roundId=newestRound;
  const canEdit=['awaiting_human','closed'].includes(task.status);
  const enteredEditor=canEdit&&!state.editable;
  state.editable=canEdit;
  el('finals-section').classList.toggle('hidden',!canEdit);
  el('final-approve-revision').classList.toggle('hidden',task.status!=='closed');
  el('objections-section').classList.toggle('hidden',!(task.rounds?.length));
  el('sources-section').classList.toggle('hidden',!task.rounds?.length&&!canEdit);
  el('recovery-section').classList.toggle('hidden',task.mode!=='api');
  if(newTask||enteredEditor){
   if(canEdit)await Promise.all([loadDraft(task.id),loadFinals(task.id)]);
   if(!el('sources-section').classList.contains('hidden'))await refreshSources();
  }
  if((newTask||newRound)&&state.roundId)await refreshObjections();
  if(task.mode==='api')await refreshRecovery();
 }
 async function approve(decision,note){
  const task=getActiveTask();if(!task)throw Error('請先選擇任務');
  if(state.conflict)throw Error('請先處理版本衝突');
  if(state.localEdit){await syncDraft();if(state.localEdit||state.conflict)throw Error('請先將草稿安全同步雲端後再核定');}
  const unverified=state.sourceItems.filter(x=>x.status!=='verified');
  const ack=!unverified.length||window.confirm('目前有 '+unverified.length+' 項尚未完成核對。你仍可人工核定，但這些狀態會記錄在該版正式定稿中。確定繼續？');
  if(!ack)return null;
  const input={expected_draft_revision:state.serverRevision,base_final_id:state.baseFinalId,
   decision,note:note||'',acknowledge_unverified:ack};
  // Retain this key across an ambiguous HTTP failure, avoiding duplicated finals.
  if(!state.approval||JSON.stringify(state.approval.body)!==JSON.stringify(input))
   state.approval={key:crypto.randomUUID(),body:input};
  const final=await api('/tasks/'+task.id+'/finals',{method:'POST',body:input,headers:{'Idempotency-Key':state.approval.key}});
  state.approval=null;state.serverRevision++;
  await reload(task.id);
  await loadDraft(task.id);await loadFinals(task.id);await refreshSources();
  showAlert('已核定正式版本 v'+final.version_no+'，舊核定版本未被覆寫');
  return final;
 }
 draft().addEventListener('input',()=>{
  if(!state.taskId)return;
  cacheText().then(scheduleSave).catch(e=>showAlert(e.message,true));
 });
 el('draft-save').addEventListener('click',()=>syncDraft());
 el('draft-use-server').addEventListener('click',async()=>{
  if(!state.conflict)return;
  const copy=state.conflict;
  if(!window.confirm('確認放棄此裝置尚未同步的修改，改用雲端版本？'))return;
  try{await clearCachedDraft(state.taskId);}catch(e){showAlert(e.message,true);}
  state.localEdit=null;state.serverRevision=copy.server_revision;state.conflict=null;
  draft().value=copy.server_body;el('draft-conflict').classList.add('hidden');
  info('已由你選用雲端草稿');
 });
 el('draft-use-local').addEventListener('click',async()=>{
  if(!state.conflict)return;
  state.serverRevision=state.conflict.server_revision;
  state.conflict=null;el('draft-conflict').classList.add('hidden');
  await cacheText();await syncDraft();
 });
 el('draft-clear-local').addEventListener('click',async()=>{
  if(!state.taskId)return;
  if(!window.confirm('清除此裝置未同步的草稿暫存可能導致編輯內容遺失。確定清除？'))return;
  await clearCachedDraft(state.taskId);state.localEdit=null;
  info('已清除本機暫存；請重新載入雲端草稿');
 });
 el('final-approve-revision').addEventListener('click',()=>{
  const note=window.prompt('請簡述這次人工修訂的原因（可留白）：');
  if(note===null)return;
  approve('manual_revision',note).catch(e=>showAlert(e.message,true));
 });
 el('source-add-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.taskId)return;
  try{
   await api('/tasks/'+state.taskId+'/source-checks',{method:'POST',body:{
    claim_text:el('source-claim').value,source_label:el('source-label').value,
    source_uri:el('source-url').value||null,status:'pending'
   }});
   e.target.reset();await refreshSources();showAlert('已加入待查證事項');
  }catch(x){showAlert(x.message,true);}
 });
 el('sources-refresh').addEventListener('click',()=>refreshSources().catch(e=>showAlert(e.message,true)));
 el('objection-add-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.roundId)return;
  try{
   await api('/tasks/'+state.taskId+'/objections',{method:'POST',body:{
    round_id:state.roundId,target_output_id:el('objection-target').value,
    objection_text:el('objection-body').value,anchor_kind:'whole'
   }});
   el('objection-body').value='';await refreshObjections();
  }catch(x){showAlert(x.message,true);}
 });
 el('objections-refresh').addEventListener('click',()=>refreshObjections().catch(e=>showAlert(e.message,true)));
 el('objections-merge').addEventListener('click',async()=>{
  const ids=[...el('objections-list').querySelectorAll('.objection-select:checked')].map(x=>x.dataset.objectionId);
  if(ids.length<2){showAlert('請先勾選至少兩項同一目標的異議',true);return;}
  const text=window.prompt('請輸入合併後的人工異議：');
  if(!text?.trim())return;
  try{
   await api('/tasks/'+state.taskId+'/objections/merge',{method:'POST',body:{
    round_id:state.roundId,objection_ids:ids,objection_text:text,reason:'人工整合異議'
   }});
   await refreshObjections();
  }catch(e){showAlert(e.message,true);}
 });
 el('retry-form').addEventListener('submit',async e=>{
  e.preventDefault();const current=state.recovery;if(!current)return;
  if(!el('retry-ack').checked){showAlert('請先確認可能重複計費的風險',true);return;}
  const [provider,phase]=el('retry-target').value.split(':');
  try{
   await api('/tasks/'+state.taskId+'/retry',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:{
    job_id:current.job_id,expected_job_revision:current.job_revision,provider,phase,
    reason:el('retry-reason').value,acknowledge_possible_charge:true
   }});
   showAlert('你已授權重試缺漏模型階段');await refreshRecovery();
  }catch(x){showAlert(x.message,true);}
 });
 el('reconcile-jobs').addEventListener('click',async()=>{
  try{const r=await api('/jobs/reconcile',{method:'POST'});
   showAlert('安全控制訊息已檢查：送出 '+r.sent+' 筆，待處理 '+r.failed+' 筆');
   await refreshRecovery();
  }catch(e){showAlert(e.message,true);}
 });
 window.addEventListener('online',()=>{if(state.localEdit&&!state.conflict)
  syncDraft().catch(e=>showAlert(e.message,true));});
 return {show,approve,refreshObjections,refreshSources,refreshRecovery};
}
