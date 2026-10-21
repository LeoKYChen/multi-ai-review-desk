import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const previous=readFileSync(new URL('../v0.8.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
test('v0.9 single-file JavaScript syntax remains valid',()=>{
 assert.ok(script);assert.doesNotThrow(()=>new vm.Script(script));
});
test('separate archived v0.8 keeps previous tested version intact',()=>{
 assert.match(previous,/<span class="pill">v0\.8<\/span>/);
 assert.match(html,/<span class="pill">v0\.9<\/span>/);
});
test('v0.9 retains v0.8 localStorage key and JSON export/import format',()=>{
 assert.ok(html.includes("const STORAGE_KEY='multi-ai-v0.8-offline-data'"));
 assert.ok(html.includes('format:\'multi-ai-offline-v0.8\''));
 assert.ok(html.includes('version:8,tasks:'));
});
test('round and phase selection are view-only and keep human decisions visible',()=>{
 for(const id of ['reader-round','reader-phase','reader-latest','reader-review','reader-caption','history'])
  assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(script,/function showRoundHistory\(t\)/);
 assert.match(script,/reader\.ordinal=round\.ordinal;showRoundHistory\(t\)/);
 assert.match(script,/review\.note/);
 assert.match(script,/reader\.phase/);
 assert.match(script,/\$\('human'\)\.classList\.toggle\('hidden',t\.status!=='awaiting_human'\|\|!isLatest\)/);
});
test('view event handlers do not submit responses or reset the answer input',()=>{
 const from=script.indexOf("$('reader-round').addEventListener");
 const to=script.indexOf("$('begin').addEventListener",from);
 const handlers=script.slice(from,to);
 assert.ok(from>=0&&to>from);
 assert.doesNotMatch(handlers,/save-answer|mutate\(|\$\('answer'\)\.value/);
});
