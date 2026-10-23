'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,webkit}=require('playwright');
(async()=>{
 const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://local').pathname;
  if(!['/','/index.html'].includes(p)){res.writeHead(404).end();return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(__dirname,'../docs/index.html')));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  for(const [engine,name] of [[chromium,'Chromium'],[webkit,'WebKit']]){
   const browser=await engine.launch({headless:true,...(name==='Chromium'?{args:['--no-sandbox']}: {})});
   try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const nonce='a'.repeat(32),origin='http://127.0.0.1:'+server.address().port;
    // Production bridge requires https://leokychen.github.io; rewrite origin only for isolated local acceptance.
    await page.route('**/*',async route=>{
     const response=await route.fetch();let html=await response.text();
     html=html.replaceAll('https://leokychen.github.io',origin);
     await route.fulfill({response,body:html});
    });
    await page.addInitScript(({nonce})=>{
     const key='psd-dual-ai-handoff:'+nonce;
     localStorage.setItem(key,JSON.stringify({nonce,createdAt:Date.now(),payload:{
      title:'114年 少年事件處理法 第2題',instruction:'雙 AI 檢查法律爭點',
      documentText:'【原題】\\n少年甲如何處遇？\\n【我的答案】\\n程序保障與涵攝'
     }}));
    },{nonce});
    await page.goto(origin+'/#psd-bridge='+nonce,{waitUntil:'domcontentloaded'});
    await page.locator('#bridge-import-summary:not(.hidden)').waitFor();
    assert.match(await page.locator('#bridge-import-title').textContent(),/114年/);
    assert.match(await page.locator('#bridge-import-text').textContent(),/【我的答案】/);
    assert.equal(await page.evaluate(n=>localStorage.getItem('psd-dual-ai-handoff:'+n),nonce),null);
    assert.equal(await page.locator('#task-title').inputValue(),'','new task form remains empty, but import preview is visible');
    await page.locator('#manual-handoff summary').click();
    await page.locator('#handoff-paste').fill(JSON.stringify({format:'psd-dual-ai-import-v1',payload:{
      title:'113年 心理學 第1題',instruction:'獨立分析心理學概念',documentText:'【原題】測驗效度\\n【我的答案】建構效度'
    }}));
    await page.locator('#handoff-import').click();
    assert.match(await page.locator('#bridge-import-title').textContent(),/113年 心理學/);
    assert.match(await page.locator('#bridge-import-text').textContent(),/建構效度/);
    assert.match(await page.locator('#handoff-message').textContent(),/已匯入並儲存/);
    assert.equal(await page.locator('#handoff-paste').inputValue(),'','manual payload cleared after import');
    assert.match(await page.locator('#bridge-task-warning').textContent(),/目前選取的是其他任務/,'warn when looking at a previous/different task');
    await page.locator('#bridge-view-task').click();
    assert.match(await page.locator('#project-title').textContent(),/114年 少年事件處理法 第2題/,'view imported must reselect the actual handoff task');
    assert.equal(await page.locator('#bridge-task-warning').isVisible(),false,'warning disappears for the imported task');
    const exportRect=await page.locator('#export').boundingBox(),deleteRect=await page.locator('#delete').boundingBox();
    assert.ok(Math.abs(exportRect.width-deleteRect.width)<2,'export/delete controls have equal widths on iPhone');
    assert.ok(Math.abs(exportRect.y+exportRect.height-deleteRect.y-deleteRect.height)<2,'export/delete controls align at bottom');

    await page.locator('#review-mode').selectOption('api');
    await page.locator('#api-settings summary').click();
    for(const id of ['test-chatgpt','test-gemini']){
     const rect=await page.locator('#'+id).boundingBox(),field=await page.locator('#model-'+id.split('-')[1]).boundingBox();
     assert.ok(Math.abs(rect.width-field.width)<3,'test button should align with input: '+id);
    }
    const clear=await page.locator('#clear-keys').boundingBox(),limit=await page.locator('#api-limit').boundingBox();
    assert.ok(clear.y>limit.y+limit.height-3,'clear keys should occupy its own full-width row on mobile');
    assert.ok(clear.x>=0&&clear.x+clear.width<=392,'clear keys should fit mobile viewport');
    assert.deepEqual(errors,[],'no runtime JS errors on '+name);
    await context.close();
    console.log(name+' iOS handoff and mobile layout passed');
   }finally{await browser.close();}
  }
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
