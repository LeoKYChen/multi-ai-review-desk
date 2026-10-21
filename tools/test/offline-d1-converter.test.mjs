import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {taskId,validateBackup,convertToSql,convertToPlan} from '../offline-d1-converter.mjs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/demo-v08-backup.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(fixture);
test('v0.8 JSON 能轉換全部任務、回合、AI 意見與人類決策',()=>{
 const p=convertToPlan(fixture);
 assert.deepEqual(p.counts,{tasks:2,rounds:2,outputs:8,reviews:1});
 assert.equal(p.records.tasks.length,2);
 assert.equal(p.records.task_rounds[0].state,'needs_rework');
 assert.equal(p.records.task_rounds[1].state,'running');
 assert.equal(p.records.tasks[0].mode,'manual');
 assert.equal(p.records.ai_outputs[0].source,'manual_unverified');
 assert.equal(p.records.human_decisions[0].note,"請補強第二段 '必要性'。");
});
test('同一份 JSON 產生穩定 UUID、SQL；標點與原始文字都保留',()=>{
 const a=convertToPlan(fixture),b=convertToPlan(clone());
 assert.deepEqual(a,b);
 assert.match(taskId('local-fallback-001'),/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
 assert.equal(taskId('11111111-1111-4111-8111-111111111111'),'11111111-1111-4111-8111-111111111111');
 const s=convertToSql(fixture).sql;
 assert.match(s,/O''Brien/);
 assert.match(s,/第2段：含 ''引用''/);
 assert.match(s,/SQLITE-ONLY TEST PREVIEW/);
 assert.doesNotMatch(s,/DROP TABLE|DELETE FROM|UPDATE tasks/i);
});
test('對帶有 SQL 注入字串的任務仍僅當文字處理',()=>{
 const x=clone();x.tasks[0].instruction="O'Hare'); DROP TABLE tasks; --";
 const sql=convertToSql(x).sql;
 assert.ok(sql.includes("O''Hare''); DROP TABLE tasks; --"));
});
test('拒絕非 v0.8、重複任務與缺少時間',()=>{
 const x=clone();x.version=7;assert.throws(()=>convertToPlan(x),/v0.8/);
 const y=clone();y.tasks[1].id=y.tasks[0].id;assert.throws(()=>convertToPlan(y),/重複/);
 const z=clone();z.tasks[0].createdAt='yesterday';assert.throws(()=>convertToPlan(z),/時間/);
});
test('拒絕錯誤回覆順序、偽造 API 來源、未核定就開下回合',()=>{
 const x=clone();x.tasks[0].rounds[0].outputs[1].provider='chatgpt';assert.throws(()=>convertToPlan(x),/順序/);
 const y=clone();y.tasks[0].rounds[0].outputs[0].source='api';assert.throws(()=>convertToPlan(y),/來源/);
 const z=clone();z.tasks[0].rounds[0].review=null;assert.throws(()=>convertToPlan(z),/退回/);
});
test('拒絕不符合狀態的回合、沒有理由的人工退回',()=>{
 const x=clone();x.tasks[0].status='closed';assert.throws(()=>convertToPlan(x),/狀態/);
 const y=clone();y.tasks[0].rounds[0].review.note='';assert.throws(()=>convertToPlan(y),/理由/);
});
test('不默默截斷超長內容、拒絕 NUL 字元',()=>{
 const x=clone();x.tasks[0].documentText='A'.repeat(50001);
 assert.throws(()=>convertToPlan(x),/限制/);
 const y=clone();y.tasks[0].instruction='nul\u0000';assert.throws(()=>convertToPlan(y),/限制/);
});
