/** Read-only safeguard before ANY remote D1 migration; never print account IDs. */
import {readFileSync} from 'node:fs';
const expectedId=(process.env.CF_STAGING_D1_DATABASE_ID||'').toLowerCase();
const expectedName='multi-ai-review-desk-staging-db';
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if(!uuid.test(expectedId))throw new Error('缺少有效的獨立測試 D1 ID');
if(expectedId===(process.env.CF_D1_DATABASE_ID||'').toLowerCase())throw new Error('staging 與既有 D1 ID 相同，禁止部署');
const path=process.argv[2];
if(!path)throw new Error('請提供 Wrangler d1 list --json 的隔離輸出檔');
let response;
try{response=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('無法驗證 Cloudflare D1 清單，禁止執行遷移');}
const rows=Array.isArray(response)?response:Array.isArray(response.result)?response.result:Array.isArray(response.databases)?response.databases:null;
if(!rows)throw new Error('Cloudflare D1 清單格式不符合預期，禁止執行遷移');
const target=rows.find(x=>x.name===expectedName);
if(!target)throw new Error('尚未建立名稱完全符合規格的獨立 staging D1');
const actualId=String(target.uuid||target.id||'').toLowerCase();
if(actualId!==expectedId)throw new Error('獨立 staging D1 名稱及 ID 不一致，禁止執行遷移');
if(rows.some(x=>x.name==='multi-ai-review-desk-db'&&String(x.uuid||x.id||'').toLowerCase()===actualId))
 throw new Error('staging 資料庫疑似正式資料庫，禁止遷移');
console.log('PASS: 由 Cloudflare 遠端清單確認獨立 staging D1 名稱與 ID 完全一致。');
