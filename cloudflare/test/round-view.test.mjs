import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('Cloudflare 前端頁面提供歷史回合與 AI 階段切換控制',()=>{
 for(const id of ['round-view','round-picker','phase-picker','latest-round','selected-review','history']){
  assert.ok(html.includes('id="'+id+'"'),id+' missing');
 }
});
test('回合切換控制僅重繪歷史，未觸發提交或修改原始內容',()=>{
 assert.doesNotThrow(()=>new vm.Script(app));
 assert.match(app,/function showRoundHistory\(task\)/);
 const start=app.indexOf("$('round-picker').addEventListener");
 const ending=app.indexOf("$('latest-round').addEventListener",start);
 assert.ok(start>0&&ending>start);
 const listeners=app.slice(start,ending);
 assert.doesNotMatch(listeners,/manual-output|\/review|mutate\(|manual-answer.*value=/);
});
test('歷史檢視停用舊回合的人類決定表單，但目前進度仍以最新回合計算',()=>{
 assert.match(app,/task\.status!=='awaiting_human'\|\|!isLatest/);
 assert.match(app,/const last=task\.rounds\?\.at\(-1\)/);
});
