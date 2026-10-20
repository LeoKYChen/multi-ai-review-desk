const $=id=>document.getElementById(id);
let activeTask=null, modelsConfigured=false, working=false;
const statusLabel={new:'尚未開始',running:'AI 審查中',awaiting_human:'待你審查',needs_rework:'退回重議',closed:'已由你結案',failed:'執行失敗'};
const phaseLabel={independent:'第一階段｜獨立分析',critique:'第二階段｜交叉審查',proposal:'第三階段｜個別修正建議'};
function showAlert(message,error=false){const el=$('notice');el.textContent=String(message);el.classList.toggle('error',error);el.classList.remove('hidden');setTimeout(()=>el.classList.add('hidden'),6500);}
async function api(path,{method='GET',body}={}){
 const headers={},options={method,credentials:'same-origin'};
 if(body!==undefined){if(body instanceof FormData)options.body=body;else{headers['Content-Type']='application/json';options.body=JSON.stringify(body);}}
 options.headers=headers;const res=await fetch('/api'+path,options);let data;
 try{data=await res.json();}catch{throw new Error('伺服器回覆無法解析');}
 if(!res.ok)throw new Error(data.error||'請求失敗');return data;
}
function setAuth(authorized){$('login').classList.toggle('hidden',authorized);$('workspace').classList.toggle('hidden',!authorized);$('signout').classList.toggle('hidden',!authorized);}
async function refreshSettings(){const data=await api('/settings');modelsConfigured=data.models_configured;$('model-state').textContent=modelsConfigured?'雙 AI API 已設定':'雙 AI API 尚未設定';$('model-state').classList.toggle('ok',modelsConfigured);$('model-state').classList.toggle('warning',!modelsConfigured);updateRun();}
function updateRun(){const el=$('run');if(!activeTask){el.disabled=true;return;}
 el.disabled=working||!modelsConfigured||!['new','running','needs_rework','failed'].includes(activeTask.status);}
function cell(text,cls){const el=document.createElement('div');if(cls)el.className=cls;el.textContent=text;return el;}
function phaseNode(name,text){const root=cell('','phase');const strong=document.createElement('strong');strong.textContent=phaseLabel[name];root.append(strong,cell(text||'尚未執行'));return root;}
function renderDetail(task){
 activeTask=task;$('detail').classList.remove('hidden');$('detail-title').textContent=task.title;$('detail-status').textContent=statusLabel[task.status]||task.status;
 $('detail-instruction').textContent=task.instruction;$('detail-word').textContent=task.document_text||'（此任務沒有 Word 附件）';
 const last=task.rounds?.at(-1);const items=last?.outputs||[];const board=$('board');board.replaceChildren();
 for(const [provider,label] of [['chatgpt','ChatGPT / OpenAI API'],['gemini','Gemini API']]){
  const lane=cell('','ai-lane');const title=document.createElement('h3');title.textContent=label;lane.append(title);
  for(const phase of ['independent','critique','proposal'])lane.append(phaseNode(phase,items.find(x=>x.provider===provider&&x.phase===phase)?.body));board.append(lane);
 }
 $('human-section').classList.toggle('hidden',task.status!=='awaiting_human');
 $('run-hint').textContent= !modelsConfigured?'尚未設定模型 API，不會自動產生模擬結果。':task.status==='awaiting_human'?'兩位 AI 均已提出建議，請由你決定。':task.status==='closed'?'此任務已由你結案。':'點一次按鈕，系統會依序完成獨立分析、交叉審查、各自提出建議。';
 const history=$('history');history.replaceChildren();for(const round of task.rounds||[]){const article=document.createElement('article');const mark=round.review?`${round.review.decision}：${round.review.note||'（無補充）'}`:'尚未人工審查';article.textContent=`第 ${round.ordinal} 回合｜${round.state}｜${mark}`;history.append(article);}
 updateRun();
}
async function loadTask(id){const data=await api('/tasks/'+id);renderDetail(data);}
async function loadList(){const result=await api('/tasks');const root=$('task-list');root.replaceChildren();if(!result.tasks.length){root.append(cell('尚無任務，請先建立一筆。','hint'));return;}
 for(const t of result.tasks){const btn=document.createElement('button');btn.className='task-item'+(activeTask?.id===t.id?' selected':'');btn.type='button';const title=document.createElement('strong');title.textContent=t.title;btn.append(title,cell(`${statusLabel[t.status]||t.status} · ${t.document_name||'無附件'}`,'small-note'));btn.addEventListener('click',()=>loadTask(t.id).catch(e=>showAlert(e.message,true)));root.append(btn);}
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
  if(result.errors?.length){showAlert(`部分模型未完成：${result.errors.map(x=>x.provider+' '+x.message).join('；')}。請再按一次接續。`,true);break;}
  if(result.status==='awaiting_human'){showAlert('兩個 AI 都已提交最終修正建議，請由你審查。');break;}
 }
 await loadList();
 }catch(e){showAlert(e.message,true);}finally{working=false;updateRun();}});
$('review-form').addEventListener('submit',async ev=>{ev.preventDefault();if(!activeTask)return;const id=activeTask.id;try{await api(`/tasks/${id}/review`,{method:'POST',body:{decision:$('decision').value,note:$('review-note').value}});$('review-note').value='';await Promise.all([loadTask(id),loadList()]);showAlert('已儲存你的最終審查決定');}catch(e){showAlert(e.message,true);}});
(async()=>{try{const res=await api('/session');setAuth(res.authenticated);if(res.authenticated)await Promise.all([refreshSettings(),loadList()]);}catch(e){setAuth(false);showAlert(e.message,true);}})();
