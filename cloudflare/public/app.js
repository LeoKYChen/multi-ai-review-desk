import {initReviewUi} from './review-ui.js';
const $=id=>document.getElementById(id);
let activeTask=null, activeManualStep=null, modelsConfigured=false, working=false;
const roundView={taskId:null,ordinal:null,phase:'all'};
let listVersion=0,searchTimer=null,backgroundTimer=null;
const statusLabel={new:'尚未開始',running:'AI 審查中',awaiting_human:'待你審查',needs_rework:'退回重議',closed:'已由你結案',failed:'執行失敗'};
const phaseLabel={independent:'第一階段｜獨立分析',critique:'第二階段｜交叉審查',proposal:'第三階段｜個別修正建議'};
function showAlert(message,error=false){const el=$('notice');el.textContent=String(message);el.classList.toggle('error',error);el.classList.remove('hidden');setTimeout(()=>el.classList.add('hidden'),6500);}
async function api(path,{method='GET',body,headers:extraHeaders={}}={}){
 const headers={...extraHeaders},options={method,credentials:'same-origin'};
 if(body!==undefined){if(body instanceof FormData)options.body=body;else{headers['Content-Type']='application/json';options.body=JSON.stringify(body);}}
 options.headers=headers;const res=await fetch('/api'+path,options);let data;
 try{data=await res.json();}catch{throw new Error('伺服器回覆無法解析');}
 if(!res.ok){const e=new Error(data.error||'請求失敗');e.status=res.status;e.code=data.code;e.details=data.details;throw e;}return data;
}
const reviewUi=initReviewUi({api,$,showAlert,getActiveTask:()=>activeTask,
 reload:async id=>{await loadTask(id);await loadList();}});
function setAuth(authorized){$('login').classList.toggle('hidden',authorized);$('workspace').classList.toggle('hidden',!authorized);$('signout').classList.toggle('hidden',!authorized);}
async function refreshSettings(){const data=await api('/settings');modelsConfigured=!!data.background_available;$('model-state').textContent=modelsConfigured?'雙 AI 背景審查已就緒':'雙 AI 背景尚未啟用';$('model-state').classList.toggle('ok',modelsConfigured);$('model-state').classList.toggle('warning',!modelsConfigured);updateRun();}
function updateRun(){
 const el=$('run');const apiMode=activeTask?.mode!=='manual';
 el.classList.toggle('hidden',!apiMode);
 el.disabled=working||!activeTask||!modelsConfigured||activeTask.queue_requested===1||!['new','needs_rework','failed'].includes(activeTask.status);
}
function cell(text,cls){const el=document.createElement('div');if(cls)el.className=cls;el.textContent=text;return el;}
function phaseNode(name,text){const root=cell('','phase');const strong=document.createElement('strong');strong.textContent=phaseLabel[name];root.append(strong,cell(text||'尚未執行'));return root;}
const reviewLabels={accept_chatgpt:'採納 ChatGPT',accept_gemini:'採納 Gemini',partial:'部分採納',reject:'不採納',rework:'退回重新討論'};
function showRoundHistory(task){
 const rounds=task.rounds||[],latest=rounds.at(-1);
 if(roundView.taskId!==task.id){roundView.taskId=task.id;roundView.ordinal=latest?.ordinal??null;roundView.phase='all';}
 if(!rounds.some(x=>x.ordinal===roundView.ordinal))roundView.ordinal=latest?.ordinal??null;
 const current=rounds.find(x=>x.ordinal===roundView.ordinal),isLatest=!!current&&current.ordinal===latest?.ordinal;
 $('round-view').classList.toggle('hidden',!current);
 const picker=$('round-picker');picker.replaceChildren();
 for(const r of rounds){const option=document.createElement('option');option.value=String(r.ordinal);option.textContent=`第 ${r.ordinal} 回合 · ${(r.outputs||[]).length}／6`;picker.append(option);}
 if(current)picker.value=String(current.ordinal);
 $('phase-picker').value=roundView.phase;$('latest-round').disabled=isLatest||!current;
 $('round-info').textContent=current?`正在檢視第 ${current.ordinal} 回合（${isLatest?'最新回合':'歷史唯讀'}）；切換不會更動原文與審查進度。`:'尚無回合';
 const decision=$('selected-review');decision.replaceChildren();
 if(current){decision.append(cell(`第 ${current.ordinal} 回合｜${current.review?(reviewLabels[current.review.decision]||current.review.decision):'尚無人工決定'}`,'round-review-title'));
  decision.append(cell(current.review?(current.review.note||'（無補充）'):'尚未人工核定','round-note'));
  if(current.review?.created_at)decision.append(cell(`核定時間：${current.review.created_at}`,'hint'));
  if(!isLatest)decision.append(cell('目前為唯讀歷史；要執行核定請先回到最新回合。','hint'));}
 const board=$('board');board.replaceChildren();
 for(const [provider,label] of [['chatgpt','ChatGPT'],['gemini','Gemini']]){
  const lane=cell('','ai-lane'),title=document.createElement('h3');title.textContent=label;lane.append(title);
  for(const phase of ['independent','critique','proposal']){
   if(roundView.phase!=='all'&&roundView.phase!==phase)continue;
   const o=current?.outputs?.find(x=>x.provider===provider&&x.phase===phase);
   lane.append(phaseNode(phase,o?(o.source==='manual_unverified'?'〔網頁版手動貼入，來源未驗證〕\n':'')+o.body:'尚未提交'));
  }board.append(lane);
 }
 $('human-section').classList.toggle('hidden',task.status!=='awaiting_human'||!isLatest);
 const history=$('history');history.replaceChildren();
 for(const r of rounds){
  const row=cell('','round-history-entry'+(r.ordinal===current?.ordinal?' selected':''));
  const info=cell('','round-history-info');info.append(cell(`第 ${r.ordinal} 回合 · ${(r.outputs||[]).length}／6 份 AI 意見`,'round-review-title'));
  info.append(cell(r.review?`${reviewLabels[r.review.decision]||r.review.decision}｜${r.review.note||'（無補充）'}`:'尚未人工核定','round-note'));
  const btn=document.createElement('button');btn.type='button';btn.className='ghost small';btn.textContent='檢視';btn.disabled=r.ordinal===current?.ordinal;
  btn.setAttribute('aria-label',`檢視第 ${r.ordinal} 回合`);btn.addEventListener('click',()=>{roundView.ordinal=r.ordinal;showRoundHistory(task);});
  row.append(info,btn);history.append(row);
 }
}
function renderDetail(task){
 activeTask=task;$('detail').classList.remove('hidden');
 const manual=task.mode==='manual';
 $('manual-section').classList.toggle('hidden',!manual);
 $('manual-begin').classList.toggle('hidden',!manual||!['new','needs_rework','failed'].includes(task.status));
 $('manual-step').classList.add('hidden');
 $('detail-title').textContent=task.title;$('detail-status').textContent=(task.category||'一般')+' · '+(statusLabel[task.status]||task.status);
 $('detail-instruction').textContent=task.instruction;$('detail-word').textContent=task.document_text||'（此任務沒有 Word 附件）';
 const last=task.rounds?.at(-1);const items=last?.outputs||[];
 const completed=items.length;
 $('progress-label').textContent=last?`第 ${last.ordinal} 回合 · ${completed}／6 份 AI 回覆`:'尚未開始';
 $('progress-fill').style.width=(Math.min(6,completed)/6*100)+'%';
 showRoundHistory(task);
 reviewUi.show(task).catch(e=>showAlert('審查管理載入失敗：'+e.message,true));
 $('run-hint').textContent=task.queue_requested===1?'已交由雲端背景佇列執行；可關閉瀏覽器，回來後查看進度。':manual?'網頁版輔助模式：需要你在 ChatGPT、Gemini 網頁操作，並把每次回覆貼回工作臺。':!modelsConfigured?'尚未設定模型 API，不會自動產生模擬結果。':task.status==='awaiting_human'?'兩位 AI 均已提出建議，請由你決定。':task.status==='closed'?'此任務已由你結案。':'點一次按鈕，系統會依序完成獨立分析、交叉審查、各自提出建議。';
 updateRun();
}
async function loadTask(id){
 const data=await api('/tasks/'+id);renderDetail(data);
 if(backgroundTimer)clearTimeout(backgroundTimer);
 if(data.mode==='api'&&data.queue_requested===1){
  backgroundTimer=setTimeout(async()=>{
   if(activeTask?.id!==id)return;
   try{await Promise.all([loadTask(id),loadList()]);}
   catch(e){showAlert('無法更新背景審查狀態：'+e.message,true);}
  },3000);
 }
 if(data.mode==='manual'&&data.status==='running')await loadManualNext(id);
}
async function loadList(){
 const id=++listVersion;
 const filters=new URLSearchParams();
 const q=$('task-search').value.trim();
 const status=$('status-filter').value;
 const category=$('category-filter').value;
 if(q)filters.set('q',q);
 if(status!=='all')filters.set('status',status);
 if(category!=='all')filters.set('category',category);
 const result=await api('/tasks'+(filters.size?'?'+filters.toString():''));
 if(id!==listVersion)return; // Ignore late search responses.
 const root=$('task-list');root.replaceChildren();
 $('task-count').textContent='（顯示 '+result.tasks.length+' 筆）';
 if(!result.tasks.length){root.append(cell('沒有符合條件的任務。','hint'));return;}
 for(const t of result.tasks){
  const btn=document.createElement('button');btn.className='task-item'+(activeTask?.id===t.id?' selected':'');btn.type='button';
  const title=document.createElement('strong');title.textContent=t.title;
  btn.append(title,cell(`${t.category||'一般'} · ${statusLabel[t.status]||t.status} · ${t.mode==='manual'?'網頁版輔助':'API'} · ${t.document_name||'無附件'}`,'small-note'));
  btn.addEventListener('click',()=>loadTask(t.id).catch(e=>showAlert(e.message,true)));root.append(btn);
 }
}
$('login-form').addEventListener('submit',async ev=>{ev.preventDefault();try{await api('/login',{method:'POST',body:{password:$('password').value}});$('password').value='';setAuth(true);await Promise.all([refreshSettings(),loadList()]);showAlert('已登入工作臺');}catch(e){showAlert(e.message,true);}});
$('signout').addEventListener('click',async()=>{try{await api('/logout',{method:'POST'});}finally{activeTask=null;setAuth(false);}});
$('task-form').addEventListener('submit',async ev=>{ev.preventDefault();const form=ev.currentTarget,button=$('task-submit');button.disabled=true;try{const file=$('document').files[0];if(file&&file.size>3*1024*1024)throw new Error('Word 檔案不得超過 3MB');const created=await api('/tasks',{method:'POST',body:new FormData(form)});form.reset();await loadList();await loadTask(created.id);showAlert(`任務建立完成，擷取了 ${created.extracted_characters} 字元。${created.warnings?.[0]||''}`);}catch(e){showAlert(e.message,true);}finally{button.disabled=false;}});
$('refresh').addEventListener('click',()=>loadList().catch(e=>showAlert(e.message,true)));
$('run').addEventListener('click',async()=>{if(!activeTask||working||!modelsConfigured)return;const id=activeTask.id;working=true;updateRun();try{
 for(let step=0;step<7;step++){
  showAlert(`雙 AI 執行中，第 ${step+1} 個階段／補跑步驟。模型請求可能需要等待。`);
  const result=await api(`/tasks/${id}/advance`,{method:'POST'});
  await loadTask(id);
  if(result.queued){showAlert('背景佇列已接收工作，可離開網頁；重新開啟後可查看最新進度。');break;}
  if(result.errors?.length){showAlert(`部分模型未完成：${result.errors.map(x=>x.provider+' '+x.message).join('；')}。請檢查原因後再按一次接續（可能額外計費）。`,true);break;}
  if(result.status==='awaiting_human'){showAlert('兩個 AI 都已提交最終修正建議，請由你審查。');break;}
 }
 await loadList();
 }catch(e){showAlert(e.message,true);}finally{working=false;updateRun();}});
$('review-form').addEventListener('submit',async ev=>{ev.preventDefault();if(!activeTask)return;const id=activeTask.id;try{
 const decision=$('decision').value,note=$('review-note').value;
 if(decision==='rework'){
  await api('/tasks/'+id+'/review',{method:'POST',body:{decision,note}});
  $('review-note').value='';await Promise.all([loadTask(id),loadList()]);showAlert('已記錄退回重議的具體要求');
 }else{
  const result=await reviewUi.approve(decision,note);
  if(result)$('review-note').value='';
 }
 }catch(e){showAlert(e.message,true);}});
(async()=>{try{const res=await api('/session');setAuth(res.authenticated);if(res.authenticated)await Promise.all([refreshSettings(),loadList()]);}catch(e){setAuth(false);showAlert(e.message,true);}})();

async function loadManualNext(taskId){
 const info=await api(`/tasks/${taskId}/manual-next`);
 if(activeTask?.id!==taskId)return;
 activeManualStep=info.complete?null:info;
 $('manual-step').classList.toggle('hidden',!!info.complete);
 if(info.complete){showAlert('兩個 AI 的六份回覆已完成，請由你審查。');return;}
 const name=info.provider==='chatgpt'?'ChatGPT':'Gemini';
 $('manual-heading').textContent=`步驟 ${Math.min(6,info.completed_steps+1)}／6 · ${name} · ${phaseLabel[info.phase]}`;
 $('manual-prompt').value=info.prompt;
 $('manual-answer').value='';
}
$('manual-begin').addEventListener('click',async()=>{
 if(!activeTask||activeTask.mode!=='manual')return;
 const id=activeTask.id;
 try{
  await api(`/tasks/${id}/manual-begin`,{method:'POST'});
  roundView.taskId=null;
  await loadTask(id);await loadList();
  showAlert('已開始手動審查，請使用下方完整指令。');
 }catch(e){showAlert(e.message,true);}
});
$('manual-copy').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText($('manual-prompt').value);showAlert('指令已複製，請貼到對應的 ChatGPT 或 Gemini 網頁。');}
 catch{showAlert('無法自動複製。請選取上方文字手動複製。',true);}
});
$('manual-form').addEventListener('submit',async ev=>{
 ev.preventDefault();
 if(!activeTask||!activeManualStep)return;
 const id=activeTask.id,step=activeManualStep;
 const answer=$('manual-answer').value;
 if(!answer.trim()){showAlert('請貼入 AI 回覆。',true);return;}
 const btn=$('manual-save');btn.disabled=true;
 try{
  const result=await api(`/tasks/${id}/manual-output`,{
   method:'POST',body:{provider:step.provider,phase:step.phase,body:answer}
  });
  await loadTask(id);await loadList();
  showAlert(result.completed?'六份回覆已儲存，等待你的最終審查。':'已儲存這份回覆，請接續下一個 AI 階段。');
 }catch(e){showAlert(e.message,true);}
 finally{btn.disabled=false;}
});

$('export-md').addEventListener('click',async()=>{
 if(!activeTask)return;
 const id=activeTask.id,button=$('export-md');button.disabled=true;
 try{
  const result=await fetch(`/api/tasks/${id}/export.md`,{credentials:'same-origin'});
  if(!result.ok){
   let problem;try{problem=await result.json();}catch{problem={};}
   throw new Error(problem.error||'匯出失敗');
  }
  const blob=await result.blob();
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`multi-ai-task-${id}.md`;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  showAlert('完整任務紀錄已下載為 Markdown，請妥善保管內含的私人文字。');
 }catch(e){showAlert(e.message,true);}
 finally{button.disabled=false;}
});
$('decision').addEventListener('change',()=>{
 const rework=$('decision').value==='rework';
 $('review-note').required=rework;
 $('review-note').placeholder=rework?'請具體說明需要重議的問題；下回合會傳給兩個 AI':'記錄採納理由或審查要求';
});

$('task-search').addEventListener('input',()=>{
 clearTimeout(searchTimer);
 searchTimer=setTimeout(()=>loadList().catch(e=>showAlert(e.message,true)),250);
});
$('status-filter').addEventListener('change',()=>loadList().catch(e=>showAlert(e.message,true)));
$('category-filter').addEventListener('change',()=>loadList().catch(e=>showAlert(e.message,true)));
$('round-picker').addEventListener('change',()=>{
 if(!activeTask)return;const n=Number($('round-picker').value);
 if(activeTask.rounds?.some(x=>x.ordinal===n)){roundView.ordinal=n;showRoundHistory(activeTask);}
});
$('phase-picker').addEventListener('change',()=>{
 if(!activeTask)return;const phase=$('phase-picker').value;
 if(['all','independent','critique','proposal'].includes(phase)){roundView.phase=phase;showRoundHistory(activeTask);}
});
$('latest-round').addEventListener('click',()=>{
 if(!activeTask)return;roundView.ordinal=activeTask.rounds?.at(-1)?.ordinal??null;showRoundHistory(activeTask);
});
