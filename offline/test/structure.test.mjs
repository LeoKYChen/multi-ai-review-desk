import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('獨立單檔可直接開啟，且沒有外部 script 或 CDN 載入',()=>{
 assert.match(html,/^<!doctype html>/i);
 assert.match(html,/<script>/);
 assert.doesNotMatch(html,/<script[^>]+src=/i);
 assert.doesNotMatch(html,/<link[^>]+(?:stylesheet|https?:)/i);
});
test('保留已測試的基本操作和 Word 擷取功能',()=>{
 for(const id of ['create-form','word-file','document-text','task-list','search','status-filter','import-json','export-json','manual-step','review-note']){
  assert.ok(html.includes('id="'+id+'"'),id+' missing');
 }
 for(const text of ['DecompressionStream','word/document.xml','localStorage','備份 JSON','匯出紀錄（MD）','來源未驗證']){
  assert.ok(html.includes(text),text+' missing');
 }
});
test('沒有以外部 API 金鑰或雲端資料庫當作離線版本前提',()=>{
 assert.doesNotMatch(html,/api\.openai\.com|generativelanguage\.googleapis\.com/);
 assert.doesNotMatch(html,/cloudflare\.com\/client\/v4/);
});
