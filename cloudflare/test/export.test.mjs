import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTaskMarkdown} from '../src/export.mjs';
const fixture={
 id:'11111111-1111-4111-8111-111111111111',title:'草案審查',mode:'manual',status:'needs_rework',
 created_at:'2026-10-20T08:00:00Z',instruction:'檢查邏輯與文字',document_text:'Word段落\n內容未更動',document_name:'原始草案.docx',
 rounds:[
  {ordinal:1,state:'needs_rework',created_at:'2026-10-20T08:01:00Z',outputs:[
   {provider:'gemini',phase:'independent',source:'manual_unverified',body:'Gemini 初步想法',created_at:'2026-10-20T08:03:00Z'},
   {provider:'chatgpt',phase:'independent',source:'api',body:'ChatGPT 分析',created_at:'2026-10-20T08:02:00Z'}
  ],review:{decision:'rework',note:'請補強第二段理由',created_at:'2026-10-20T08:04:00Z'}},
  {ordinal:2,state:'running',created_at:'2026-10-20T09:00:00Z',outputs:[],review:null}
 ]
};
test('Markdown 匯出保留原交辦、Word文字、各回合、人工決定',()=>{
 const s=renderTaskMarkdown(fixture);
 for(const word of ['草案審查','檢查邏輯與文字','Word段落','Word段落\n內容未更動',
    '第 1 回合','第 2 回合','ChatGPT 分析','Gemini 初步想法','請補強第二段理由','尚未人工審查']){
  assert.ok(s.includes(word),word);
 }
});
test('網頁手動貼入須保留來源未驗證註記，不偽稱模型 API',()=>{
 const s=renderTaskMarkdown(fixture);
 assert.match(s,/網頁版手動貼入，來源未驗證/);
 assert.match(s,/伺服器端模型 API 紀錄/);
});
test('匯出不會默默刪掉 Markdown fence 或原始文字',()=>{
 const source='包含 ~~~~ 特殊分隔符及\n# 標題';
 const s=renderTaskMarkdown({...fixture,document_text:source});
 assert.ok(s.includes(source));
 assert.ok(s.includes('~~~~~text'));
});
test('沒有完整任務歷程時拒絕匯出',()=>{
 assert.throws(()=>renderTaskMarkdown({title:'不完整'}),/完整/);
});
