/** Manual remote D1 export. Never commits backup or secrets; requires authenticated Wrangler. */
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=resolve(project,'..','private-backups');
mkdirSync(directory,{recursive:true,mode:0o700});
try{chmodSync(directory,0o700);}catch{/* Windows filesystem may not support POSIX permissions */}
const iso=new Date().toISOString().replace(/[.:]/g,'-');
const output=join(directory,`review-desk-${iso}.sql`);
if(existsSync(output))throw new Error('備份檔案名稱衝突，已停止執行');
console.log('開始從遠端 Cloudflare D1 匯出，請先確定 Wrangler 已登入。');
const npx=process.platform==='win32'?'npx.cmd':'npx';
execFileSync(npx,['wrangler','d1','export','multi-ai-review-desk-db','--remote',`--output=${output}`],{cwd:project,stdio:'inherit'});
try{chmodSync(output,0o600);}catch{/* Windows */}
console.log(`備份已儲存在本機：${output}`);
console.log('提醒：備份內包含交辦指令與 AI 意見，請妥善保管，不要上傳 GitHub。');
