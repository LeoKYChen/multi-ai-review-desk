import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,readdirSync} from 'node:fs';
import {
 parseCritiqueText,locateQuote,critiqueStatements,getObjections,createHumanObjection,
 correctObjection,resolveCritique,listSources,createSource,updateSource
} from '../src/review-evidence.mjs';

const out1='11111111-1111-4111-8111-111111111111';
const out2='22222222-2222-4222-8222-222222222222';
const critique='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const roundId='55555555-5555-4555-8555-555555555555';
const original='第一點，這個規範需要獨立查證。\n第二點，這是另一段。';
const records=[
 {id:out1,provider:'chatgpt',phase:'independent',body:original},
 {id:out2,provider:'gemini',phase:'independent',body:'Gemini 初稿。'}
];
function database(){
 const d=new DatabaseSync(':memory:');d.exec('PRAGMA foreign_keys=ON');
 const dir=resolve(dirname(fileURLToPath(import.meta.url)),'../migrations');
 for(const f of readdirSync(dir).filter(n=>/^\d{4}_.+\.sql$/.test(n)).sort())
  d.exec(readFileSync(resolve(dir,f),'utf8'));
 const DB={prepare(sql){return {bind(...args){
  const stmt=d.prepare(sql);
  return {run:async()=>({meta:{changes:stmt.run(...args).changes}}),
   first:async()=>stmt.get(...args)||null,
   all:async()=>({results:stmt.all(...args)})};
 }};},async batch(statements){
  d.exec('BEGIN');try{
   const out=[];for(const s of statements)out.push(await s.run());
   d.exec('COMMIT');return out;
  }catch(e){d.exec('ROLLBACK');throw e;}
 }};
 d.prepare("INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at) VALUES(?,?,?,'','new','t0','t0')").run(taskId,'題目','請審查');
 d.prepare("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,1,'running','t0')").run(roundId,taskId);
 for(const r of records){
  d.prepare("INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,'t0')")
   .run(r.id,roundId,r.provider,r.phase,r.body);
 }
 d.prepare("INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,'t0')")
  .run(critique,roundId,'gemini','critique','完整交叉評論');
 return {d,env:{DB}};
}

test('有效交叉評論：一字不差引用來源；合法空陣列也是已解析',()=>{
 const block='先提出完整自然語言評論。\nBEGIN_FEEDBACK_OBJECTIONS\n'+
  JSON.stringify({objections:[{target_provider:'chatgpt',quote:'這個規範需要獨立查證',reason:'缺少資料依據'}]})+
  '\nEND_FEEDBACK_OBJECTIONS';
 const parsed=parseCritiqueText(block,records);
 assert.equal(parsed.valid,true);
 assert.equal(parsed.items[0].target_output_id,out1);
 assert.equal(original.slice(parsed.items[0].start_offset,parsed.items[0].end_offset),'這個規範需要獨立查證');
 assert.deepEqual(parseCritiqueText('BEGIN_FEEDBACK_OBJECTIONS\n{"objections":[]}\nEND_FEEDBACK_OBJECTIONS',records),{valid:true,error:null,items:[]});
});

test('不能捏造引用、格式錯誤要停，重複引用退回整份定位',()=>{
 assert.equal(parseCritiqueText('沒有 JSON',records).error,'MISSING_OR_DUPLICATED_STRUCTURE');
 assert.equal(parseCritiqueText('BEGIN_FEEDBACK_OBJECTIONS\n{}\nEND_FEEDBACK_OBJECTIONS',records).valid,false);
 const invalid='BEGIN_FEEDBACK_OBJECTIONS\n'+JSON.stringify({objections:[
  {target_provider:'chatgpt',quote:'不存在的法律原文',reason:'有疑問'}
 ]})+'\nEND_FEEDBACK_OBJECTIONS';
 assert.equal(parseCritiqueText(invalid,records).error,'QUOTE_NOT_IN_ORIGINAL');
 assert.equal(locateQuote('相同 相同','相同').anchor_kind,'whole');
});

test('原始評論、異議與解析狀態同交易保存；人類補正只追加事件',async()=>{
 const {d,env}=database();
 const text='說明\nBEGIN_FEEDBACK_OBJECTIONS\n'+JSON.stringify({objections:[
  {target_provider:'chatgpt',quote:'這個規範需要獨立查證',reason:'需要補資料'}
 ]})+'\nEND_FEEDBACK_OBJECTIONS';
 // New critique output would be inserted atomically along with these statements.
 const id='66666666-6666-4666-8666-666666666666';
 const bundle=critiqueStatements(env.DB,{body:text,outputId:id,roundId,records});
 await env.DB.batch([
  env.DB.prepare("INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,'t1')").bind(id,roundId,'chatgpt','critique',text),
  ...bundle.statements
 ]);
 const items=(await getObjections(env,taskId,roundId)).items;
 assert.equal(items.length,1);assert.equal(items[0].source_critique_output_id,id);
 assert.equal(items[0].revision,0);
 const updated=await correctObjection(env,taskId,items[0].id,{expected_revision:0,
  objection_text:'已人工校正理由',reason:'原論點不足'});
 assert.equal(updated.revision,1);
 const latest=(await getObjections(env,taskId,roundId)).items[0];
 assert.equal(latest.objection_text,'已人工校正理由');
 assert.equal(d.prepare('SELECT objection_text FROM review_objections WHERE id=?').get(items[0].id).objection_text,'需要補資料');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM objection_events').get().n,1);
 await assert.rejects(()=>correctObjection(env,taskId,items[0].id,{
  expected_revision:0,objection_text:'舊裝置不應覆寫'}),/已更新/);
});

test('手動異議只能指向同一回合的 AI 原文，引用不能冒充精確定位',async()=>{
 const {env}=database();
 await assert.rejects(()=>createHumanObjection(env,taskId,{
  round_id:roundId,target_output_id:out1,anchor_kind:'sentence',
  quoted_text:'無此文字',objection_text:'質疑'}),/無法唯一定位/);
 const response=await createHumanObjection(env,taskId,{
  round_id:roundId,target_output_id:out1,anchor_kind:'whole',
  objection_text:'我認為仍有問題'});
 assert.ok(response.id);assert.equal(response.origin,'human');
 const items=(await getObjections(env,taskId,roundId)).items;
 assert.equal(items.length,1);assert.equal(items[0].anchor_kind,'whole');
});

test('來源查證：AI 推論不得自動升級為已查證；人類核對留下事件',async()=>{
 const {d,env}=database();
 const source=await createSource(env,taskId,{
  claim_text:'某條法律規範',source_label:'官方法規待查',status:'pending',
  related_ai_output_id:out1
 });
 assert.equal((await listSources(env,taskId)).items[0].status,'pending');
 await assert.rejects(()=>updateSource(env,taskId,source.id,{
  status:'verified',expected_revision:0
 }),/實際來源與人工核對/);
 const updated=await updateSource(env,taskId,source.id,{
  status:'verified',expected_revision:0,evidence_note:'我已親自核對來源'});
 assert.equal(updated.revision,1);
 assert.equal((await listSources(env,taskId)).items[0].status,'verified');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM source_check_events WHERE source_check_id=?').get(source.id).n,2);
 await assert.rejects(()=>updateSource(env,taskId,source.id,{
  status:'pending',expected_revision:0
 }),/版本衝突/);
});

test('錯誤結構的原文仍可由人工確認解析，不得自動偽造空異議',async()=>{
 const {d,env}=database();
 d.prepare("INSERT INTO critique_parse_status(ai_output_id,status,error_code,checked_at) VALUES(?,?,'INVALID_JSON','t0')")
  .run(critique,'needs_human');
 const result=await resolveCritique(env,taskId,roundId,critique);
 assert.equal(result.resolved,true);
 assert.equal(result.requires_owner_ack,true);
 assert.equal(d.prepare('SELECT status FROM critique_parse_status WHERE ai_output_id=?').get(critique).status,'resolved');
});
