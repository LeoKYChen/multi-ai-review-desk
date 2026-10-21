import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {shouldClearCachedDraft,detectDraftConflict,draftPayload} from '../public/draft-cache.js';

test('只有完全相同的本機 edit 身分與內容能被已成功同步的 ACK 清除',()=>{
 const first={task_id:'a',local_edit_id:'edit1',base_revision:5,body:'較早草稿'};
 const newer={...first,local_edit_id:'edit2',body:'稍後的新內容'};
 assert.equal(shouldClearCachedDraft(first,first),true);
 assert.equal(shouldClearCachedDraft(newer,first),false);
 assert.equal(shouldClearCachedDraft({...first,task_id:'b'},first),false);
 assert.equal(shouldClearCachedDraft({...first,body:'不同'},first),false);
 assert.equal(shouldClearCachedDraft({...first,base_revision:6},first),false);
});

test('版本衝突只由雲端 revision 差異判斷，絕不自動覆蓋',()=>{
 const local={base_revision:3,body:'本機草稿'};
 assert.equal(detectDraftConflict(local,{revision:4,body:'已被手機更新'}),true);
 assert.equal(detectDraftConflict(local,{revision:3,body:'相同基準'}),false);
 assert.equal(detectDraftConflict(null,{revision:5}),false);
});

test('本機暫存項使用每次編輯獨立 ID；記錄基礎 revision 而非宣稱雲端已存',()=>{
 const x=draftPayload('task-id','內容',7),y=draftPayload('task-id','更新文字',7);
 assert.equal(x.base_revision,7);assert.equal(x.task_id,'task-id');
 assert.equal(x.body,'內容');
 assert.notEqual(x.local_edit_id,y.local_edit_id);
 assert.equal(Object.hasOwn(x,'cloud_synced'),false);
});

test('新版網頁控制器引用的元素均實際存在於 HTML，不靠假按鈕',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../public/review-ui.js',import.meta.url),'utf8');
 const ids=new Set([...js.matchAll(/\bel\('([^']+)'\)/g)].map(x=>x[1]));
 assert.ok(ids.size>=20,'too few review UI bindings');
 for(const id of ids)assert.ok(html.includes('id="'+id+'"'),'missing element '+id);
 for(const name of ['draft-conflict','finals-section','objections-section','sources-section','recovery-section'])
  assert.ok(html.includes('id="'+name+'"'));
 assert.match(html,/type="module" src="\/app\.js"/);
 assert.match(js,/writeCachedDraft/);
 assert.match(js,/clearCachedDraftIf/);
 assert.match(js,/DRAFT_VERSION_CONFLICT/);
});

test('前端原始碼與本機暫存實作不應包含模型 Secret 名稱或金鑰',()=>{
 for(const path of ['../public/app.js','../public/review-ui.js','../public/draft-cache.js']){
  const js=readFileSync(new URL(path,import.meta.url),'utf8');
  for(const forbidden of ['OPENAI_API_KEY','GEMINI_API_KEY','OWNER_TOKEN','CLOUDFLARE_API_TOKEN'])
   assert.ok(!js.includes(forbidden),path+' exposed sensitive variable '+forbidden);
 }
});
