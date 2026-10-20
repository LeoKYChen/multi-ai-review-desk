const $=id=>document.getElementById(id);
let activeTask=null, activeManualStep=null, modelsConfigured=false, working=false;
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
function updateRun(){
 const el=$('run');const apiMode=activeTask?.mode!=='manual';
 el.classList.toggle('hidden',!apiMode);
 el.disabled=working||!activeTask||!modelsConfigured||!['new','running','needs_rework','failed'].includes(activeTask.status);
}
function cell(text,cls){const el=document.createElement('div');if(cls)el.className=cls;el.textContent=text;return el;}
function phaseNode(name,text){const root=cell('','phase');const strong=document.createElement('strong');strong.textContent=phaseLabel[name];root.append(strong,cell(text||'尚未執行'));return root;}
function renderDetail(task){
 activeTask=task;$('detail').classList.remove('hidden');
 const manual=task.mode==='manual';
 $('manual-section').classList.toggle('hidden',!manual);
 $('manual-begin').classList.toggle('hidden',!manual||!['new','needs_rework','failed'].includes(task.status));
 $('manual-step').classList.add('hidden');
 $('detail-title').textContent=task.title;$('detail-status').textContent=statusLabel[task.status]||task.status;
 $('detail-instruction').textContent=task.instruction;$('detail-word').textContent=task.document_text||'（此任務沒有 Word 附件）';
 const last=task.rounds?.at(-1);const items=last?.outputs||[];const board=$('board');board.replaceChildren();
 for(const [provider,label] of [['chatgpt','ChatGPT / OpenAI API'],['gemini','Gemini API']]){
  const lane=cell('','ai-lane');const title=document.createElement('h3');title.textContent=label;lane.append(title);
  for(const phase of ['independent','critique','proposal']){
   const output=items.find(x=>x.provider===provider&&x.phase===phase);
   const text=output?(output.source==='manual_unverified'?'〔網頁版手動貼入，來源未驗證〕\n':'')+output.body:null;
   lane.append(phaseNode(phase,text));
  }
  board.append(lane);
 }
 $('human-section').classList.toggle('hidden',task.status!=='awaiting_human');
 $('run-hint').textContent= manual?'網頁版輔助模式：需要你在 ChatGPT、Gemini 網頁操作，並把每次回覆貼回工作臺。':!modelsConfigured?'尚未設定模型 API，不會自動產生模擬結果。':task.status==='awaiting_human'?'兩位 AI 均已提出建議，請由你決定。':task.status==='closed'?'此任務已由你結案。':'點一次按鈕，系統會依序完成獨立分析、交叉審查、各自提出建議。';
 const history=$('history');history.replaceChildren();for(const round of task.rounds||[]){const article=document.createElement('article');const mark=round.review?`${round.review.decision}：${round.review.note||'（無補充）'}`:'尚未人工審查';article.textContent=`第 ${round.ordinal} 回合｜${round.state}｜${mark}`;history.append(article);}
 updateRun();
}
async function loadTask(id){
 const data=await api('/tasks/'+id);renderDetail(data);
 if(data.mode==='manual'&&data.status==='running')await loadManualNext(id);
}
async function loadList(){const result=await api('/tasks');const root=$('task-list');root.replaceChildren();if(!result.tasks.length){root.append(cell('尚無任務，請先建立一筆。','hint'));return;}
 for(const t of result.tasks){const btn=document.createElement('button');btn.className='task-item'+(activeTask?.id===t.id?' selected':'');btn.type='button';const title=document.createElement('strong');title.textContent=t.title;btn.append(title,cell(`${statusLabel[t.status]||t.status} · ${t.mode==='manual'?'網頁版輔助':'API'} · ${t.document_name||'無附件'}`,'small-note'));btn.addEventListener('click',()=>loadTask(t.id).catch(e=>showAlert(e.message,true)));root.append(btn);}
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
