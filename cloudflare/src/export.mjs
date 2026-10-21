/** Export complete human-readable task history without original Word bytes.
 * Keep pasted web responses explicitly marked unverified.
 */
const states={new:'尚未開始',running:'審查中',awaiting_human:'待人工審查',needs_rework:'待重新討論',closed:'已結案',failed:'執行失敗'};
const decisions={accept_chatgpt:'採納 ChatGPT 建議',accept_gemini:'採納 Gemini 建議',partial:'部分採納／自行綜整',reject:'不採納',rework:'退回重新討論'};
const phases={independent:'獨立分析',critique:'交叉審查',proposal:'各自最終修正建議'};
const providers={chatgpt:'ChatGPT',gemini:'Gemini'};
function safeHeading(value){
 return String(value??'').replace(/[\r\n]+/g,' ').replace(/[\\#*\x60[\]<>_]/g,' ').trim()||'未命名';
}
function block(value){
 const text=String(value??'');
 const runs=[...text.matchAll(/~+/g)].map(m=>m[0].length);
 const fence='~'.repeat(Math.max(4,(runs.length?Math.max(...runs):0)+1));
 return fence+'text\n'+text+'\n'+fence;
}
export function renderTaskMarkdown(task){
 if(!task||!task.id||!Array.isArray(task.rounds))throw new TypeError('需要完整的任務與歷次審查紀錄');
 const lines=[
  '# '+safeHeading(task.title),
  '',
  '> Multi-AI 審查紀錄匯出。AI 意見為建議，並非自動決策。網頁版手動貼入內容未經模型來源驗證。',
  '',
  '- 任務編號：'+task.id,
  '- 模式：'+(task.mode==='manual'?'ChatGPT／Gemini 網頁版輔助':'模型 API'),
  '- 狀態：'+(states[task.status]||task.status),
  '- 建立時間：'+(task.created_at||'未記錄'),
  '- 匯出時間：'+new Date().toISOString(),
  '- 原始 Word 檔：'+(task.document_name||'未附檔；原始檔未永久保存'),
  '',
  '## 原始交辦指令',
  '',block(task.instruction),'',
  '## Word 擷取文字',
  '',block(task.document_text||'（未附 Word 文件）'),'',
 ];
 for(const round of task.rounds){
  lines.push('## 第 '+round.ordinal+' 回合', '',
   '- 回合狀態：'+(states[round.state]||round.state),
   '- 開始時間：'+(round.created_at||'未記錄'),'');
  const outputs=[...(round.outputs||[])].sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||''))||
    ['independent','critique','proposal'].indexOf(a.phase)-['independent','critique','proposal'].indexOf(b.phase));
  if(!outputs.length)lines.push('（尚未產生 AI 意見）','');
  for(const out of outputs){
   lines.push('### '+(providers[out.provider]||safeHeading(out.provider))+'：'+(phases[out.phase]||safeHeading(out.phase)),
   '',
   '- 建立時間：'+(out.created_at||'未記錄'),
   '- 來源：'+(out.source==='manual_unverified'?'網頁版手動貼入，來源未驗證':'伺服器端模型 API 紀錄'),
   '',block(out.body),'');
  }
  if(round.review){
   lines.push('### 人工審查決定','',
    '- 決定：'+(decisions[round.review.decision]||safeHeading(round.review.decision)),
    '- 決定時間：'+(round.review.created_at||'未記錄'),
    '',block(round.review.note||'（無補充說明）'),'');
  }else lines.push('### 人工審查決定','','（尚未人工審查）','');
 }
 const finals=task.final_versions||[];
 if(finals.length){
  lines.push('## 人工正式核定版本（不可覆寫）','');
  for(const f of finals){
   lines.push('### 核定版本 v'+f.version_no,'',
    '- 核定時間：'+f.approved_at,
    '- 核定種類：'+(decisions[f.decision]||f.decision),
    '- 前一版本：'+(f.parent_version_id||'（第一版）'),
    '',block(f.body),'','核定備註：',block(f.note||'（無）'),'',
    '#### 本版本核定當時的來源及查證狀態','');
   let snapshot;try{snapshot=JSON.parse(f.source_snapshot_json);}catch{snapshot=[];}
   if(!snapshot.length)lines.push('（核定時沒有來源記錄）','');
   for(const s of snapshot){
    lines.push('- 主張：'+safeHeading(s.claim_text),
     '  - 來源：'+(s.source_label||'未附來源'),
     '  - 核定當時查證狀態：'+s.status,
     '  - 核對者／時間：'+(s.verified_by||'未核對')+'／'+(s.verified_at||'無'),'');
   }
  }
 }
 if((task.objections||[]).length){
  lines.push('## 結構化異議與人工處理軌跡','');
  for(const o of task.objections){
   lines.push('### 異議 '+o.id,'',
    '- 原始評論：'+(o.source_critique_output_id||'人工新增'),
    '- 被質疑模型原文：'+o.target_output_id,
    '- 原句／段落定位：'+o.anchor_kind,
    '',block(o.quoted_text||'（整份評論）'),'',
    '異議內容：',block(o.objection_text),'');
   for(const e of (task.objection_events||[]).filter(x=>x.objection_id===o.id))
    lines.push('- '+e.created_at+'：'+e.actor+' '+e.action+' '+e.details_json);
  }
 }
 if((task.current_sources||[]).length){
  lines.push('## 目前查證狀態（可能不同於核定當時）','');
  for(const s of task.current_sources){
   lines.push('- 主張：'+safeHeading(s.claim_text),
    '  - 來源：'+(s.source_label||'未附來源')+(s.source_uri?'｜'+s.source_uri:''),
    '  - 目前狀態：'+s.status,
    '  - 最近更新：'+s.updated_at,'');
  }
 }
 lines.push('---','','本檔案只保存已擷取文字與審查紀錄，不包含 Word 原檔、影像或模型帳號資料。','');
 return lines.join('\n');
}
