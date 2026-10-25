'use strict';
// Manual rounds can use Claude (or any two different web AIs), and long prompts show their size
// with an optional compact form for use in the same chat. No real AI calls are made.
const assert=require('node:assert/strict'),http=require('node:http');
const playwright=require('playwright');
const {readState}=require('./idb-state.cjs');
const {serveDocs}=require('./serve-docs.cjs');
const engines=(process.env.PW_ENGINES||'chromium,webkit').split(',');
(async()=>{
 const server=http.createServer((req,res)=>{if(!serveDocs(req,res))res.writeHead(404).end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  for(const name of engines){
   const browser=await playwright[name].launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{})});
   try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(()=>{window.__opened=[];window.open=url=>{window.__opened.push(url);return null;};});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
    await page.locator('#task-title').fill('Claude 手動測試');
    await page.locator('#instruction').fill('測試指令');
    await page.locator('#document-text').fill('【文件標記】'+'甲'.repeat(31000));
    await page.locator('#create-submit').click();

    // Two different AIs are required.
    await page.locator('#manual-service-chatgpt').selectOption('claude');
    await page.locator('#manual-service-gemini').selectOption('claude');
    await page.locator('#begin').click();
    assert.match(await page.locator('#toast').textContent(),/不同的 AI/);
    assert.equal((await readState(page)).tasks[0].rounds.length,0,'no round started with the same AI twice');

    await page.locator('#manual-service-chatgpt').selectOption('openai');
    await page.locator('#begin').click();
    await page.waitForFunction(()=>document.getElementById('stage-heading').textContent.includes('ChatGPT'));
    assert.equal(await page.locator('#manual-service-gemini').isDisabled(),true,'AIs are fixed once the round starts');
    assert.match(await page.locator('#board').textContent(),/Claude/);
    // Stage one carries the whole document, so a long one is flagged; compact mode cannot shorten it.
    assert.equal(await page.locator('#prompt-size.long').count(),1,'long prompt flagged');
    assert.match(await page.locator('#prompt-size').textContent(),/縮短文件/);

    const save=async text=>{await page.locator('#answer').fill(text);await page.locator('#save-answer').click();};
    await save('【A 初稿】');
    assert.match(await page.locator('#stage-heading').textContent(),/Claude/);
    await page.locator('#open-provider').click();
    assert.deepEqual(await page.evaluate(()=>window.__opened),['https://claude.ai/'],'opens the chosen AI');
    await save('【B 初稿】');await save('【A 對 B 的批評】');await save('【B 對 A 的批評】');

    // Stage three for AI A: full prompt carries everything; compact keeps only A's draft and B's critique.
    const full=await page.locator('#prompt').inputValue();
    for(const marker of ['【文件標記】','【A 初稿】','【B 初稿】','【A 對 B 的批評】','【B 對 A 的批評】'])assert.ok(full.includes(marker),'full prompt has '+marker);
    await page.locator('#compact-prompt').check();
    const compact=await page.locator('#prompt').inputValue();
    assert.ok(compact.includes('【A 初稿】')&&compact.includes('【B 對 A 的批評】'));
    for(const marker of ['【文件標記】','【B 初稿】','【A 對 B 的批評】'])assert.ok(!compact.includes(marker),'compact prompt omits '+marker);
    assert.ok(compact.length<full.length/5);
    assert.equal(await page.locator('#prompt-size.long').count(),0);
    assert.match(await page.locator('#prompt-size').textContent(),new RegExp(compact.length.toLocaleString('zh-TW')));

    // Choices survive a reload and a JSON backup round trip.
    await save('【A 修正】');await save('【B 修正】');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.getElementById('project-status').textContent.includes('待人工核定'));
    assert.equal(await page.locator('#compact-prompt').isChecked(),true,'compact preference remembered');
    assert.equal(await page.locator('#decision option[value="accept_gemini"]').textContent(),'採納 Claude 建議');
    const state=await readState(page);
    assert.deepEqual(state.tasks[0].rounds[0].services,{chatgpt:'openai',gemini:'claude'});
    await page.locator('#import-json').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:8,selectedId:state.tasks[0].id,tasks:state.tasks}))});
    await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('JSON 已還原'));
    assert.equal(await page.locator('#decision option[value="accept_gemini"]').textContent(),'採納 Claude 建議','services restored from backup');
    assert.deepEqual(errors,[],'unexpected JS errors in '+name);
    await context.close();
    console.log(name+': manual Claude selection and compact prompts passed');
   }finally{await browser.close();}
  }
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
