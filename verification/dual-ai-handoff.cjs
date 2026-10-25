'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../docs/index.html'),'utf8');
const js=html.match(/<script>([\s\S]*?)<\/script>/);
assert(js&&js[1],'embedded application script found');
new vm.Script(js[1],{filename:'docs/index.html:inline'});
assert(html.includes('id="bridge-return"'));
assert(html.includes('const BRIDGE_PROTOCOL="psd-dual-ai-v1"'));
assert(html.includes('event.origin!==BRIDGE_ORIGIN||event.source!==window.opener'),'check origin and opener');
assert(html.includes('bridgeNonce')&&html.includes('d.nonce!==bridgeNonce'),'check per-window nonce');
assert(html.includes('state.tasks.length>=100'),'preserve task limit');
assert(html.includes('if(!await save()){state.tasks=state.tasks.filter(x=>x.id!==t.id);state.selectedId=oldId;'),'rollback failed task creation by id');
assert(html.includes('r.outputs.length!==6'),'return only complete cross-review');
assert(html.includes("bridgeSend('return',{text:result})"));
const extract=html.match(/function reviewForLearning\(t\)\{([\s\S]*?)\n\}\nwindow\.addEventListener/);
assert(extract,'return serializer is available');
const serializer=vm.runInNewContext('function reviewForLearning(t){'+extract[1]+'\n};reviewForLearning',{
 last:t=>t.rounds.at(-1),phases:['independent','critique','proposal'],
 providers:['chatgpt','gemini'],names:{independent:'獨立',critique:'交叉',proposal:'修正'},
 label:(_t,p)=>p,decisionLabel:()=> '部分採納'
});
const outputs=['independent','critique','proposal'].flatMap(phase=>['chatgpt','gemini'].map(provider=>({phase,provider,body:'批改內容'})));
const task={title:'測試題',rounds:[{outputs,review:null}]};
assert.throws(()=>serializer(task),/人工審查決定/);
task.rounds[0].review={decision:'rework',note:'重作'};
assert.throws(()=>serializer(task),/退回重作/);
task.rounds[0].review={decision:'partial',note:'人工核定'};
assert.match(serializer(task),/人工核定/);
console.log('PASS dual-AI handoff scripts parse and guard untrusted messages');
