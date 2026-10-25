'use strict';
// Two desk tabs, unsaved drafts, provenance after reload, API binding after a failed call,
// and cleanup of stale bridge records. Mocked API only: no real keys or paid calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const playwright=require('playwright');
const {readState}=require('./idb-state.cjs');
const KEY='multi-ai-v0.8-offline-data';
const engines=(process.env.PW_ENGINES||'chromium,webkit').split(',');
(async()=>{
 const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://local').pathname;
  if(!['/','/index.html'].includes(p)){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'../docs/index.html')));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  for(const name of engines){
   const browser=await playwright[name].launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{})});
   try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const errors=[];
    const open=async()=>{const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(origin+'/',{waitUntil:'domcontentloaded'});return page;};
    const create=async(page,title)=>{await page.locator('#task-title').fill(title);await page.locator('#instruction').fill('測試指令 '+title);await page.locator('#create-submit').click();};
    const stored=readState;
    const titles=async page=>(await stored(page)).tasks.map(t=>t.title).sort();

    // Stale bridge records are swept on load; fresh ones (an active handoff) are kept.
    await context.addInitScript(()=>{if(sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','1');
     localStorage.setItem('psd-dual-ai-return:'+'c'.repeat(32),JSON.stringify({nonce:'c'.repeat(32),text:'x'.repeat(1000),createdAt:Date.now()-3600000}));
     localStorage.setItem('psd-dual-ai-ack:'+'d'.repeat(32),'not json');
     localStorage.setItem('psd-dual-ai-handoff:'+'e'.repeat(32),JSON.stringify({nonce:'e'.repeat(32),createdAt:Date.now()}));});
    const a=await open();
    assert.equal(await a.evaluate(()=>localStorage.getItem('psd-dual-ai-return:'+'c'.repeat(32))),null,'stale return record removed');
    assert.equal(await a.evaluate(()=>localStorage.getItem('psd-dual-ai-ack:'+'d'.repeat(32))),null,'unreadable bridge record removed');
    assert.notEqual(await a.evaluate(()=>localStorage.getItem('psd-dual-ai-handoff:'+'e'.repeat(32))),null,'fresh handoff kept');

    // Tab B is opened before tab A creates anything, so its in-memory state is stale.
    const b=await open();
    await a.bringToFront();await create(a,'分頁甲任務');
    await b.bringToFront();await create(b,'分頁乙任務');
    assert.deepEqual(await titles(b),['分頁乙任務','分頁甲任務'],'stale tab must not overwrite the other tab task');
    await a.bringToFront();
    await a.waitForFunction(()=>document.getElementById('task-list').textContent.includes('分頁乙任務'));
    // Deleting in one tab is not undone when the other tab saves.
    await a.locator('.task',{hasText:'分頁乙任務'}).click();
    await a.locator('#delete').click();
    await b.bringToFront();
    await b.waitForFunction(()=>!document.getElementById('task-list').textContent.includes('分頁乙任務'));
    await create(b,'分頁乙第二任務');
    assert.deepEqual(await titles(b),['分頁乙第二任務','分頁甲任務'],'deleted task stays deleted');

    // A pasted but unsaved reply survives switching tasks and syncs from the other tab.
    await b.locator('.task',{hasText:'分頁甲任務'}).click();
    await b.locator('#begin').click();
    await b.locator('#answer').fill('尚未儲存的草稿');
    await b.locator('.task',{hasText:'分頁乙第二任務'}).click();
    await a.bringToFront();await create(a,'觸發同步');
    await b.bringToFront();
    await b.waitForFunction(()=>document.getElementById('task-list').textContent.includes('觸發同步'));
    await b.locator('.task',{hasText:'分頁甲任務'}).click();
    assert.equal(await b.locator('#answer').inputValue(),'尚未儲存的草稿','draft kept across re-renders');
    await b.locator('#save-answer').click();
    assert.equal(await b.locator('#answer').inputValue(),'','next step starts empty');
    // Saving is async: reading IndexedDB waits for the pending write, so this confirms it committed before reloading.
    assert.equal((await stored(b)).tasks.find(t=>t.title==='分頁甲任務').rounds[0].outputs.length,1,'reply committed before reload');

    // Manual provenance survives a reload instead of turning into "imported".
    await b.reload({waitUntil:'domcontentloaded'});
    await b.locator('.task',{hasText:'分頁甲任務'}).click();
    assert.match(await b.locator('#board').textContent(),/手動貼入/);
    assert.doesNotMatch(await b.locator('#board').textContent(),/備份還原/);
    assert.equal((await stored(b)).tasks.find(t=>t.title==='分頁甲任務').rounds[0].outputs[0].source,'manual_unverified');

    // A failed first API call does not lock the round to the mistyped model; provider detail is shown.
    await a.close();
    let fail=true;const calls=[];
    await b.route('https://api.openai.com/v1/responses',async route=>{const body=route.request().postDataJSON();calls.push(body.model);
     if(fail){await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{message:'The model `typo-model` does not exist'}})});return;}
     await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'模擬回覆'}]}]})});});
    await create(b,'API 綁定測試');await b.locator('#begin').click();
    await b.locator('#review-mode').selectOption('api');await b.locator('#api-settings summary').click();
    assert.equal(await b.locator('#api-limit').inputValue(),'12288');
    await b.locator('#key-chatgpt').fill('test-only-a');await b.locator('#key-gemini').fill('test-only-b');
    await b.locator('#model-chatgpt').fill('typo-model');await b.locator('#model-gemini').fill('test-model-b');
    await b.locator('#api-next').click();
    await b.waitForFunction(()=>document.getElementById('api-status').textContent.includes('已暫停'));
    assert.match(await b.locator('#api-status').textContent(),/typo-model` does not exist/,'provider error message shown');
    const task=()=>stored(b).then(s=>s.tasks.find(t=>t.title==='API 綁定測試'));
    assert.equal((await task()).rounds[0].participants,undefined,'round not bound after failure');
    fail=false;await b.locator('#model-chatgpt').fill('fixed-model');await b.locator('#api-next').click();
    await b.waitForFunction(()=>document.getElementById('api-status').textContent.includes('此步驟已完成'));
    const bound=(await task()).rounds[0];
    assert.equal(bound.participants.chatgpt.model,'fixed-model');
    assert.equal(bound.outputs[0].source,'api');
    assert.deepEqual(calls,['typo-model','fixed-model']);
    assert.ok(!JSON.stringify(await stored(b)).includes('test-only-'),'API keys must not be persisted');
    assert.equal(await b.evaluate(k=>localStorage.getItem(k),KEY),null,'tasks are no longer kept in shared localStorage');
    assert.deepEqual(errors,[],'unexpected JS errors in '+name);
    await context.close();

    // Data saved by earlier versions in localStorage moves into IndexedDB with its provenance, freeing the shared quota.
    const legacy={version:8,selectedId:'legacy-1',tasks:[{id:'legacy-1',title:'舊版本機任務',instruction:'舊指令',documentText:'',category:'一般',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',status:'running',
     rounds:[{ordinal:1,startedAt:'2026-10-01T00:00:00.000Z',review:null,participants:{chatgpt:{service:'openai',model:'m-a'},gemini:{service:'gemini',model:'m-b'}},outputs:[{phase:'independent',provider:'chatgpt',body:'舊 API 回覆',source:'api',service:'openai',model:'m-a',createdAt:'2026-10-01T00:00:00.000Z'}]}]}]};
    const migrate=await browser.newContext();
    await migrate.addInitScript(([k,v])=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem(k,v);}},[KEY,JSON.stringify(legacy)]);
    const m=await migrate.newPage();m.on('pageerror',e=>errors.push(e.message));
    await m.goto(origin+'/',{waitUntil:'domcontentloaded'});
    await m.waitForFunction(()=>document.getElementById('project-title').textContent==='舊版本機任務');
    assert.match(await m.locator('#board').textContent(),/API 直接回覆/);
    const moved=await readState(m);
    assert.equal(moved.tasks.length,1);assert.equal(moved.tasks[0].rounds[0].outputs[0].source,'api');
    assert.equal(await m.evaluate(k=>localStorage.getItem(k),KEY),null,'legacy localStorage copy removed after migration');
    await m.reload({waitUntil:'domcontentloaded'});
    await m.waitForFunction(()=>document.getElementById('project-title').textContent==='舊版本機任務');
    await migrate.close();

    // Without IndexedDB the desk falls back to localStorage and still works.
    const fallback=await browser.newContext();
    await fallback.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true}));
    const f=await fallback.newPage();f.on('pageerror',e=>errors.push(e.message));f.on('dialog',d=>d.accept());
    await f.goto(origin+'/',{waitUntil:'domcontentloaded'});
    await create(f,'相容模式任務');
    await f.waitForFunction(()=>document.getElementById('storage-state').textContent.includes('相容模式'));
    assert.equal((await f.evaluate(k=>JSON.parse(localStorage.getItem(k)),KEY)).tasks[0].title,'相容模式任務');
    await f.reload({waitUntil:'domcontentloaded'});
    assert.match(await f.locator('#task-list').textContent(),/相容模式任務/);
    await fallback.close();
    assert.deepEqual(errors,[],'unexpected JS errors in '+name);
    console.log(name+': multi-tab merge, drafts, provenance, API binding, bridge cleanup, IndexedDB migration and fallback passed');
   }finally{await browser.close();}
  }
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
