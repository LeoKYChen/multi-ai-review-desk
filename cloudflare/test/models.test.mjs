import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel, makePrompt, ready } from '../src/models.mjs';
const task={title:'一般文字檢查',instruction:'提出問題與建議',document_text:'第一段的文字'};
const rows=[{provider:'chatgpt',phase:'independent',body:'A 初稿'},{provider:'gemini',phase:'independent',body:'B 初稿'},{provider:'chatgpt',phase:'critique',body:'A 交叉審查'},{provider:'gemini',phase:'critique',body:'B 交叉審查'}];
const env={OPENAI_API_KEY:'test-key',OPENAI_MODEL:'example-openai-model',GEMINI_API_KEY:'gemini-test',GEMINI_MODEL:'example-gemini-model'};
test('模型設定沒有四項必備資料就不啟動',()=>{assert.equal(ready({}),false);assert.equal(ready(env),true);});
test('獨立分析提示詞不包含其他 AI 初稿',()=>{const p=makePrompt(task,'independent','chatgpt',rows);assert.doesNotMatch(p,/A 初稿|B 初稿/);assert.match(p,/第一段的文字/);});
test('交叉意見須看到兩份獨立初稿',()=>{const p=makePrompt(task,'critique','gemini',rows);assert.match(p,/A 初稿/);assert.match(p,/B 初稿/);assert.doesNotMatch(p,/A 交叉審查/);});
test('個別最終建議看到雙方交叉意見，且禁止擅自決定',()=>{const p=makePrompt(task,'proposal','chatgpt',rows);assert.match(p,/A 交叉審查/);assert.match(p,/B 交叉審查/);assert.match(p,/不要修改原文/);});
test('OpenAI Responses API 模擬回應，禁用儲存',async()=>{
 let args;const fetcher=async(u,o)=>{args={u,o};return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:'A 建議'}]}]})};};
 assert.equal(await callModel('chatgpt',env,'提示',fetcher),'A 建議');assert.equal(args.u,'https://api.openai.com/v1/responses');
 assert.equal(JSON.parse(args.o.body).store,false);assert.equal(args.o.headers.Authorization,'Bearer test-key');
});
test('Gemini generateContent API 模擬回應',async()=>{
 let args;const fetcher=async(u,o)=>{args={u,o};return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'G 建議'}]}}]})};};
 assert.equal(await callModel('gemini',env,'提示',fetcher),'G 建議');assert.match(args.u,/generativelanguage.googleapis.com/);assert.equal(args.o.headers['x-goog-api-key'],'gemini-test');
});
test('模型 API 錯誤不得輸出密鑰',async()=>{
 const fetcher=async()=>({ok:false,status:429});await assert.rejects(()=>callModel('gemini',env,'提示',fetcher),e=>!e.message.includes('gemini-test')&&/429/.test(e.message));
});
