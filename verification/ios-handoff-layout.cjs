'use strict';
const assert=require('node:assert/strict'),http=require('node:http');
const {chromium,webkit}=require('playwright');
const {serveDocs}=require('./serve-docs.cjs');
(async()=>{
 const server=http.createServer((req,res)=>{
  if(!serveDocs(req,res))res.writeHead(404).end();
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
    // With nothing selected yet, the platform task is shown directly; no warning panels appear.
    await page.waitForFunction(()=>document.getElementById('project-title').textContent.includes('114年'));
    assert.match(await page.locator('#source').textContent(),/【我的答案】/);
    assert.match(await page.locator('#task-list').textContent(),/來自平臺/);
    assert.equal(await page.locator('[role=alert]:visible').count(),0,'no warning banners for a platform import');
    assert.equal(await page.evaluate(n=>localStorage.getItem('psd-dual-ai-handoff:'+n),nonce),null);
    assert.equal(await page.locator('#task-title').inputValue(),'','new task form remains empty');
    // Pasting the platform JSON still works and becomes an ordinary, unlinked task.
    await page.locator('#manual-handoff summary').click();
    await page.locator('#handoff-paste').fill(JSON.stringify({format:'psd-dual-ai-import-v1',payload:{
      title:'113年 心理學 第1題',instruction:'獨立分析心理學概念',documentText:'【原題】測驗效度\\n【我的答案】建構效度'
    }}));
    await page.locator('#handoff-import').click();
    await page.waitForFunction(()=>document.getElementById('handoff-paste').value==='','import saved');
    assert.match(await page.locator('#project-title').textContent(),/113年 心理學/);
    assert.match(await page.locator('#source').textContent(),/建構效度/);
    assert.match(await page.locator('#handoff-message').textContent(),/已匯入並儲存/);
    assert.equal(await page.locator('#handoff-paste').inputValue(),'','manual payload cleared after import');
    assert.equal(await page.locator('#bridge-return').isVisible(),false,'only the linked task can return to the platform');
    assert.equal(await page.locator('#bridge-status').isVisible(),false,'platform status hidden on other tasks');
    // Plain text needs no platform format; title comes from the first line, category is user-chosen.
    await page.locator('#handoff-category').selectOption('備考');
    await page.locator('#handoff-paste').fill('115年 刑法 第3題\n【我的答案】構成要件該當');
    await page.locator('#handoff-import').click();
    await page.waitForFunction(()=>document.getElementById('handoff-paste').value==='','import saved');
    assert.equal(await page.locator('#project-title').textContent(),'115年 刑法 第3題');
    assert.equal(await page.locator('#task-category').inputValue(),'備考');
    assert.match(await page.locator('#original').textContent(),/題目與作答/);
    await page.locator('#task-category').selectOption('研究分析');
    assert.match(await page.locator('.task.active').textContent(),/研究分析/,'category can be changed after import');
    await page.locator('.task',{hasText:'114年 少年事件處理法 第2題'}).click();
    assert.equal(await page.locator('#bridge-return').isVisible(),true,'linked task keeps its return action');
    assert.match(await page.locator('#bridge-status').textContent(),/來自學習平臺/);
    const buttons=await page.evaluate(()=>{const a=document.getElementById('export').getBoundingClientRect(),b=document.getElementById('delete').getBoundingClientRect();return {exportWidth:a.width,deleteWidth:b.width,exportBottom:a.bottom,deleteBottom:b.bottom};});
    assert.ok(Math.abs(buttons.exportWidth-buttons.deleteWidth)<2,'export/delete controls have equal widths on iPhone');
    assert.ok(Math.abs(buttons.exportBottom-buttons.deleteBottom)<2,'export/delete controls align at bottom');

    // A later platform handoff adds its task without switching away from the one being viewed.
    const nonce2='f'.repeat(32);
    await page.evaluate(n=>localStorage.setItem('psd-dual-ai-handoff:'+n,JSON.stringify({nonce:n,createdAt:Date.now(),payload:{title:'112年 社會工作 第4題',instruction:'檢查',documentText:'【我的答案】資源連結'}})),nonce2);
    await page.goto(origin+'/#psd-bridge='+nonce2,{waitUntil:'domcontentloaded'});await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.getElementById('task-list').textContent.includes('112年 社會工作'));
    assert.match(await page.locator('#project-title').textContent(),/114年 少年事件處理法/,'current task stays selected');
    assert.match(await page.locator('#toast').textContent(),/左側任務清單/);
    assert.equal(await page.locator('[role=alert]:visible').count(),0);

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
