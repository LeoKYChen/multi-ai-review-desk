import test from 'node:test';
import assert from 'node:assert/strict';
import {nextManualStep} from '../src/manual.mjs';
test('網頁版輔助依序完成六份 AI 回覆',()=>{
 const steps=[],records=[];
 for(let i=0;i<6;i++){
  const s=nextManualStep(records);
  assert.ok(s);steps.push(s.phase+':'+s.provider);records.push(s);
 }
 assert.deepEqual(steps,['independent:chatgpt','independent:gemini','critique:chatgpt','critique:gemini','proposal:chatgpt','proposal:gemini']);
 assert.equal(nextManualStep(records),null);
});
test('先等待另一個獨立初稿，不會提前交叉審查',()=>{
 assert.deepEqual(nextManualStep([{phase:'independent',provider:'chatgpt'}]),{phase:'independent',provider:'gemini'});
});
