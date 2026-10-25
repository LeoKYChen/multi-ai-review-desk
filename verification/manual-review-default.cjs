'use strict';
// Extends the unmerged PR #7 roundtrip scenario without modifying its branch.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium,webkit}=require('playwright');
// Existing restore marks all outputs imported_unverified and keeps binding on participants.
const reviewContent=data=>{const copy=JSON.parse(JSON.stringify(data));for(const t of copy.tasks)for(const r of t.rounds)for(const o of r.outputs){delete o.source;delete o.service;delete o.model;delete o.number;}return copy;};

(async()=>{
 const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://local').pathname;
  if(p==='/source.html'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
   res.end('<!doctype html><title>mock exam source</title><script>void localStorage.length;window.received=[];window.addEventListener("storage",e=>{if(e.key&&e.key.startsWith("psd-dual-ai-"))window.received.push({key:e.key,value:e.newValue});});</script>');
   return;
  }
  if(p!=='/'&&p!=='/index.html'){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(fs.readFileSync(path.join(__dirname,'../docs/index.html')));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [engine,name] of [[chromium,'Chromium'],[webkit,'WebKit']].filter(([,n])=>!process.env.PW_ENGINES||process.env.PW_ENGINES.toLowerCase().includes(n.toLowerCase()))){
   const browser=await engine.launch({headless:true,...(name==='Chromium'?{args:['--no-sandbox']}: {})});
   try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const source=await context.newPage();
    await source.goto(origin+'/source.html');
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(origin+'/**',async route=>{
     const response=await route.fetch();
     await route.fulfill({response,body:(await response.text()).replaceAll('https://leokychen.github.io',origin)});
    });
    const nonce='b'.repeat(32);
    await page.addInitScript(({nonce})=>{
     if(localStorage.getItem('multi-ai-v0.8-offline-data'))return; // Do not reseed a completed import after reload.
     localStorage.setItem('psd-dual-ai-handoff:'+nonce,JSON.stringify({
      nonce,createdAt:Date.now(),
      payload:{
       title:'114年 少年事件處理法 第2題（模擬測試）',
       instruction:'僅供測試：檢查六階段意見是否完整',
       documentText:'【原題】少年保護事件（測試）\\n【我的答案】程序保障與涵攝（測試）'
      }
     }));
    },{nonce});
    await page.goto(origin+'/#psd-bridge='+nonce,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.getElementById('project-title').textContent.includes('114年'));
    const external=[];
    page.on('request',request=>{if(!request.url().startsWith(origin))external.push(request.url());});
    assert.equal(await page.locator('#review-mode').inputValue(),'manual');
    assert.equal(await page.locator('#api-settings').isVisible(),false);
    assert.equal(await page.locator('#api-controls').isVisible(),false);
    assert.equal(await page.locator('body').innerText().then(t=>/cloudflare|pages\.dev|workers\.dev/i.test(t)),false,'no cloud UI or prompts');
    assert.equal(await page.locator('a[href*="pages.dev"],a[href*="workers.dev"],a[href*="cloudflare"]').count(),0);

    await page.screenshot({path:path.join(process.env.REVIEW_SCREENSHOT_DIR||require('node:os').tmpdir(),'manual-default-'+name+'.png'),fullPage:true});
    assert.match(await page.locator('#source').textContent(),/【我的答案】/);
    assert.equal(await page.locator('#bridge-return').isVisible(),true,'return action should exist only for linked task');
    const returnKey='psd-dual-ai-return:'+nonce;
    await page.locator('#bridge-return').click();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),returnKey),null,'no return without completed round');
    await page.locator('#begin').click();
    assert.match(await page.locator('#progress-label').textContent(),/0／6/);
    for(let i=1;i<=6;i++){
     await page.locator('#answer').fill('【測試評語 '+i+'】第'+i+'步，僅供流程驗證，非 AI 實際批改');
     await page.locator('#save-answer').click();
     assert.match(await page.locator('#progress-label').textContent(),new RegExp(i+'／6'));
    }
    assert.deepEqual(external,[],'manual flow sends no external requests');
    const before=await page.evaluate(()=>localStorage.getItem('multi-ai-v0.8-offline-data'));
    await page.locator('#review-mode').selectOption('api');
    assert.equal(await page.locator('#api-settings').isVisible(),true);
    await page.locator('#review-mode').selectOption('manual');
    assert.equal(await page.locator('#api-settings').isVisible(),false);
    assert.equal(await page.evaluate(()=>localStorage.getItem('multi-ai-v0.8-offline-data')),before,'mode switches preserve source and all six opinions');
    assert.match(await page.locator('#project-status').textContent(),/待人工核定/);
    await page.locator('#bridge-return').click();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),returnKey),null,'no return before human decision');
    await page.locator('#decision').selectOption('partial');
    await page.locator('#review-note').fill('測試：保留爭議，人工核對法律來源');
    await page.locator('#save-review').click();
    assert.match(await page.locator('#project-status').textContent(),/已由人類結案/);
    await page.locator('#bridge-return').click();
    // WebKit may suspend storage events while the original tab is in the background.
    await source.bringToFront();
    await source.waitForFunction(key=>window.received.some(e=>e.key===key&&e.value),returnKey,{polling:100});
    const payload=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),returnKey);
    assert.equal(payload.nonce,nonce);
    assert.match(payload.text,/114年 少年事件處理法 第2題/);
    for(let i=1;i<=6;i++)assert.ok(payload.text.includes('【測試評語 '+i+'】'),'missing mock stage '+i);
    assert.match(payload.text,/人工核定/);
    assert.match(payload.text,/測試：保留爭議/);
    await source.evaluate(({nonce})=>{
     localStorage.setItem('psd-dual-ai-ack:'+nonce,JSON.stringify({nonce,ok:true,createdAt:Date.now()}));
    },{nonce});
    await page.bringToFront();
    await page.waitForFunction(()=>document.getElementById('bridge-status').textContent.includes('已成功寫回'));
    // A full storage quota must neither block the direct message nor claim success when nothing was sent.
    await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(String(k).startsWith('psd-dual-ai-return:'))throw new DOMException('full','QuotaExceededError');return window.__setItem.call(this,k,v);};});
    await page.evaluate(()=>{window.__posted=[];Object.defineProperty(window,'opener',{configurable:true,value:{postMessage:m=>window.__posted.push(m)}});});
    await page.locator('#bridge-return').click();
    assert.equal(await page.evaluate(()=>window.__posted.filter(m=>m.kind==='return'&&m.text.includes('人工核定')).length),1,'direct message still sent when storage write fails');
    assert.match(await page.locator('#bridge-status').textContent(),/已送出回傳請求/);
    await page.evaluate(()=>{Object.defineProperty(window,'opener',{configurable:true,value:null});document.getElementById('bridge-status').textContent='';});
    await page.locator('#bridge-return').click();
    assert.match(await page.locator('#toast').textContent(),/無法回傳/,'both channels failing is reported');
    assert.equal(await page.locator('#bridge-status').textContent(),'','no false success message');
    await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem;});
    const completed=await page.evaluate(()=>JSON.parse(localStorage.getItem('multi-ai-v0.8-offline-data')));
    await page.locator('#review-mode').selectOption('api');
    await page.reload({waitUntil:'domcontentloaded'});
    assert.equal(await page.locator('#review-mode').inputValue(),'manual','reload always defaults to manual');
    assert.deepEqual(reviewContent(await page.evaluate(()=>JSON.parse(localStorage.getItem('multi-ai-v0.8-offline-data')))),reviewContent(completed),'completed review and original answer survive reload');
    assert.match(await page.locator('#reader-count').textContent(),/共 1 回合/);
    assert.match(await page.locator('#source').textContent(),/【我的答案】/);
    // Exercise all six automatic API steps with intercepted responses. No real API keys or paid calls.
    const calls=[];
    await page.route('https://api.openai.com/v1/responses',async route=>{
     const req=route.request(),body=req.postDataJSON();
     calls.push({provider:'openai',input:body.input,model:body.model,headers:req.headers()});
     await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      status:'completed',output:[{type:'message',content:[{type:'output_text',text:'【模擬 OpenAI 評語】'+calls.length}]}]
     })});
    });
    await page.route('https://generativelanguage.googleapis.com/v1beta/models/**',async route=>{
     const req=route.request(),body=req.postDataJSON();
     calls.push({provider:'gemini',input:body.contents?.[0]?.parts?.[0]?.text,model:req.url(),headers:req.headers()});
     await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      candidates:[{finishReason:'STOP',content:{parts:[{text:'【模擬 Gemini 評語】'+calls.length}]}}]
     })});
    });
    await page.locator('#task-title').fill('模擬 API 六階段測試');
    await page.locator('#instruction').fill('測試兩家服務各三份評語');
    await page.locator('#document-text').fill('測試題幹及答案（非真實個案）');
    await page.locator('#create-submit').click();
    await page.locator('#begin').click();
    await page.locator('#review-mode').selectOption('api');
    await page.locator('#api-settings summary').click();
    await page.locator('#key-chatgpt').fill('test-only-openai');
    await page.locator('#key-gemini').fill('test-only-gemini');
    await page.locator('#model-chatgpt').fill('test-model-a');
    await page.locator('#model-gemini').fill('test-model-b');
    page.on('dialog',dialog=>dialog.accept());
    await page.locator('#api-all').click();
    await page.waitForFunction(()=>document.querySelector('#project-status')?.textContent.includes('待人工核定'),{timeout:20000});
    assert.equal(calls.length,6,'exactly six mocked API calls');
    assert.equal(calls.filter(x=>x.provider==='openai').length,3);
    assert.equal(calls.filter(x=>x.provider==='gemini').length,3);
    assert.ok(calls.every(x=>x.input.includes('測試題幹及答案')),'every AI step includes the source question');
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('multi-ai-v0.8-offline-data')));
    const task=saved.tasks.find(x=>x.title==='模擬 API 六階段測試');
    assert.equal(task.rounds[0].outputs.length,6,'mocked outputs saved');
    assert.equal(task.rounds[0].participants.chatgpt.service,'openai');
    assert.equal(task.rounds[0].participants.gemini.service,'gemini');
    assert.ok(!JSON.stringify(saved).includes('test-only-openai')&&!JSON.stringify(saved).includes('test-only-gemini'),'API keys must not be persisted');
    await page.locator('#review-mode').selectOption('manual');
    const apiSaved=await page.evaluate(()=>JSON.parse(localStorage.getItem('multi-ai-v0.8-offline-data')));
    await page.reload({waitUntil:'domcontentloaded'});
    assert.equal(await page.locator('#review-mode').inputValue(),'manual');
    assert.equal(await page.locator('#api-settings').isVisible(),false);
    assert.deepEqual(reviewContent(await page.evaluate(()=>JSON.parse(localStorage.getItem('multi-ai-v0.8-offline-data')))),reviewContent(apiSaved),'API participants and completed outputs preserved');
    await page.locator('#review-mode').selectOption('api');
    const selector=await page.locator('#review-mode').boundingBox();
    assert.ok(selector.x>=0&&selector.x+selector.width<=392,'mode selector fits mobile viewport');
    await page.screenshot({path:path.join(process.env.REVIEW_SCREENSHOT_DIR||require('node:os').tmpdir(),'manual-review-'+name+'.png'),fullPage:true});
    assert.deepEqual(errors,[],'unexpected JS errors in '+name);
    await context.close();
    console.log(name+': six mock outputs, human decision, origin-linked return, acknowledgement, and reload passed');
   }finally{await browser.close();}
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
