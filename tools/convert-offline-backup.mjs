#!/usr/bin/env node
/**
 * Local-only backup preview. Does NOT connect to Cloudflare or run SQL.
 * Usage: node tools/convert-offline-backup.mjs backup.json [--output private-imports/plan.json]
 */
import {readFileSync,writeFileSync,statSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {convertToPlan} from './offline-d1-converter.mjs';

function usage(){
 console.log('使用方式：node tools/convert-offline-backup.mjs <離線備份.json> [--output <計畫.json>]');
 console.log('預設僅檢查及顯示筆數；--output 才儲存包含私人文字的 D1 匯入計畫。');
}
function main(args){
 if(args.includes('--help')||args.includes('-h')){usage();return;}
 if(args.length!==1&&!(args.length===3&&args[1]==='--output'))throw Error('參數格式不正確，使用 --help 查閱');
 const path=resolve(args[0]),stat=statSync(path);
 if(!stat.isFile()||stat.size>8*1024*1024)throw Error('JSON 備份必須是 8 MB 以下的檔案');
 let backup;const raw=readFileSync(path);
 try{backup=JSON.parse(raw.toString('utf8'));}catch{throw Error('JSON 解析失敗，請使用離線工作臺匯出的原始備份');}
 const plan=convertToPlan(backup);
 const hash=createHash('sha256').update(raw).digest('hex');
 console.log('格式驗證：PASS（離線 v0.8）');
 console.log('任務 '+plan.counts.tasks+'；回合 '+plan.counts.rounds+
  '；模型回覆 '+plan.counts.outputs+'；人工決定 '+plan.counts.reviews);
 console.log('原始 JSON SHA-256：'+hash);
 console.log('來源標記：全部為 manual_unverified；不會假裝經過模型 API 驗證');
 if(args.length===3){
  const target=resolve(args[2]);if(!target.endsWith('.json'))throw Error('匯出檔名須為 .json');
  if(target===path)throw Error('不得覆寫原始備份檔');
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  writeFileSync(target,JSON.stringify({...plan,source_sha256:hash},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('已建立匯入計畫：'+target);
  console.log('警告：計畫含完整私人文字、未加密；不得上傳 GitHub 或公開網站。');
  console.log('此計畫不可直接當作 Cloudflare D1 備份或直接匯入正式 D1。');
 }else console.log('本次只有預覽，沒有寫出檔案，更沒有變更 D1。');
}
try{main(process.argv.slice(2));}catch(e){
 // Do not log input source text. A validator exception contains only field names/indices.
 console.error('轉換失敗：'+e.message);
 process.exitCode=1;
}
