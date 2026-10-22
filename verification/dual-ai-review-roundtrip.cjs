'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium,webkit}=require('playwright');

(async()=>{
 const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://local').pathname;
  if(p==='/source.html'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
   res.end('<!doctype html><title>mock exam source</title><script>window.received=[];window.addEventListener("storage",e=>{if(e.key&&e.key.startsWith("psd-dual-ai-"))window.received.push({key:e.key,value:e.newValue});});</script>');
   return;
  }
  if(p!=='/'&&p!=='/index.html'){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(fs.readFileSync(path.join(__dirname,'../docs/index.html')));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [engine,name] of [[chromium,'Chromium'],[webkit,'WebKit']]){
   const browser=await engine.launch({headless:true,...(name==='Chromium'?{args:['--no-sandbox']}: {})});
   try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const source=await context.newPage();
    await source.goto(origin+'/source.html');
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
     const response=await route.fetch();
     await route.fulfill({response,body:(await response.text()).replaceAll('https://leokychen.github.io',origin)});
    });
    const nonce='b'.repeat(32);
    await page.addInitScript(({nonce})=>{
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
    await page.locator('#bridge-import-summary:not(.hidden)').waitFor();
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
    assert.match(await page.locator('#project-status').textContent(),/待人工核定/);
    await page.locator('#bridge-return').click();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),returnKey),null,'no return before human decision');
    await page.locator('#decision').selectOption('partial');
    await page.locator('#review-note').fill('測試：保留爭議，人工核對法律來源');
    await page.locator('#save-review').click();
    assert.match(await page.locator('#project-status').textContent(),/已由人類結案/);
    await page.locator('#bridge-return').click();
    await source.waitForFunction(key=>window.received.some(e=>e.key===key&&e.value),returnKey);
    const payload=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),returnKey);
    assert.equal(payload.nonce,nonce);
    assert.match(payload.text,/114年 少年事件處理法 第2題/);
    for(let i=1;i<=6;i++)assert.ok(payload.text.includes('【測試評語 '+i+'】'),'missing mock stage '+i);
    assert.match(payload.text,/人工核定/);
    assert.match(payload.text,/測試：保留爭議/);
    await source.evaluate(({nonce})=>{
     localStorage.setItem('psd-dual-ai-ack:'+nonce,JSON.stringify({nonce,ok:true,createdAt:Date.now()}));
    },{nonce});
    await page.waitForFunction(()=>document.getElementById('bridge-status').textContent.includes('已成功寫回'));
    await page.reload({waitUntil:'domcontentloaded'});
    assert.match(await page.locator('#reader-count').textContent(),/共 1 回合/);
    assert.match(await page.locator('#source').textContent(),/【我的答案】/);
    assert.deepEqual(errors,[],'unexpected JS errors in '+name);
    await context.close();
    console.log(name+': six mock outputs, human decision, origin-linked return, acknowledgement, and reload passed');
   }finally{await browser.close();}
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
