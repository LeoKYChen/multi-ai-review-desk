import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTaskFilters,buildTaskListQuery} from '../src/task-query.mjs';
test('分類、狀態、搜尋可以組合',()=>{
 const q=parseTaskFilters(new URL('https://test.invalid/api/tasks?q=法律&status=running&category=文件審查'));
 assert.deepEqual(q,{q:'法律',status:'running',category:'文件審查'});
 const built=buildTaskListQuery(q);
 assert.match(built.sql,/category=\?/);assert.match(built.sql,/status=\?/);
 assert.deepEqual(built.params,['法律','法律','法律','running','文件審查']);
});
test('搜尋條件永不直接拼接進 SQL',()=>{
 const payload="x' OR 1=1 --";
 const built=buildTaskListQuery({q:payload});
 assert.doesNotMatch(built.sql,/OR 1=1/);
 assert.equal(built.params[0],payload);
});
test('無效的狀態、過長搜尋、非法分類都遭拒絕',()=>{
 assert.throws(()=>parseTaskFilters(new URL('https://t/api/tasks?status=evil')),/無效/);
 assert.throws(()=>parseTaskFilters(new URL('https://t/api/tasks?q='+('A'.repeat(101)))),/100/);
 assert.throws(()=>parseTaskFilters(new URL('https://t/api/tasks?category='+('Z'.repeat(31)))),/分類/);
});
test('無條件查詢回傳最多 100 筆，依更新時間排序',()=>{
 const result=buildTaskListQuery();
 assert.match(result.sql,/updated_at DESC LIMIT 100/);
 assert.deepEqual(result.params,[]);
});
