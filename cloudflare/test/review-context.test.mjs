import test from 'node:test';
import assert from 'node:assert/strict';
import {getPreviousReworkNote} from '../src/review-context.mjs';
import {makePrompt} from '../src/models.mjs';
test('第一回合沒有前次退回理由，不查詢 D1',async()=>{
 assert.equal(await getPreviousReworkNote({DB:null},'task-id',1),'');
});
test('後續回合只取得先前人工退回的理由',async()=>{
 let params;
 const db={prepare(sql){
  assert.match(sql,/human_decisions/);
  assert.match(sql,/h\.decision='rework'/);
  return {bind(...xs){params=xs;return {first:async()=>({note:'請補強後果分析'})};}};
 }};
 const note=await getPreviousReworkNote({DB:db},'task-id',2);
 assert.equal(note,'請補強後果分析');
 assert.deepEqual(params,['task-id',2]);
});
test('退回理由進入新回合初稿，卻不洩漏對方新回合初稿',()=>{
 const task={title:'再審',instruction:'提出意見',document_text:'原始文件'};
 const other=[{provider:'gemini',phase:'independent',body:'另一模型的同回合初稿'}];
 const prompt=makePrompt(task,'independent','chatgpt',other,24000,'請補強後果分析');
 assert.match(prompt,/請補強後果分析/);
 assert.doesNotMatch(prompt,/另一模型的同回合初稿/);
 assert.match(prompt,/原始文件/);
});
test('退回理由太長時應明確要求拆分，不得默默截斷',()=>{
 const task={title:'題目',instruction:'檢視',document_text:'原始'};
 assert.throws(()=>makePrompt(task,'independent','chatgpt',[],100,'X'.repeat(200)),/超過/);
});
