/** Generate a staging-only Wrangler config from GitHub Actions variables.
 * No actual database UUID or credential is committed to GitHub.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbId = process.env.CF_STAGING_D1_DATABASE_ID ?? '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(dbId)) throw new Error('GitHub variable CF_STAGING_D1_DATABASE_ID 必須是獨立測試 D1 的 UUID');
if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('GitHub variable CLOUDFLARE_ACCOUNT_ID 必須是 Cloudflare Account ID');
let config = readFileSync(join(projectRoot, 'wrangler.toml.example'), 'utf8');
if (!config.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID')) throw new Error('找不到設定檔中的 D1 佔位字串');
if (dbId.toLowerCase() === (process.env.CF_D1_DATABASE_ID??'').toLowerCase()) throw new Error('測試資料庫 ID 不得與既有 DB 相同');
config = config.replace('REPLACE_WITH_YOUR_D1_DATABASE_ID', dbId);
config = config.replace('database_name = "multi-ai-review-desk-db"','database_name = "multi-ai-review-desk-staging-db"');
if (!config.includes('database_name = "multi-ai-review-desk-staging-db"')) throw new Error('未設定獨立 staging D1');
config = config.replace(/^name = "multi-ai-review-desk"$/m, 'name = "multi-ai-review-desk-staging"');
config = config.replace('workers_dev = false', 'workers_dev = false\npreview_urls = false');
config += '\n[vars]\nMODEL_API_ENABLED = "false"\nBACKGROUND_JOBS_ENABLED = "false"\nMODEL_MAX_CALLS_PER_TASK = "12"\nMODEL_MAX_CALLS_PER_DAY = "12"\n';
// Provision closed by default: even a Worker upload creates no public URL.
// "activate" is a second step after the owner configures Worker-level Access.
const stage=process.env.STAGING_NETWORK_MODE??'closed';
if (!['closed','access-protected'].includes(stage)) throw new Error('STAGING_NETWORK_MODE 無效');
if(stage==='access-protected'){
 if(process.env.STAGING_ACCESS_CONFIRMED!=='true')throw new Error('需本人確認已設定 Worker-level Access 並包含 All traffic');
 config=config.replace('workers_dev = false','workers_dev = true');
}
const out = join(projectRoot, 'wrangler.toml');
if (existsSync(out)) throw new Error('已存在 wrangler.toml；為避免覆蓋既有設定，請在乾淨的部署工作目錄執行');
writeFileSync(out, config, { mode: 0o600 });
console.log('已建立私人部署設定：Cloudflare Worker staging；D1 binding DB；模型 API 預設停用。');
console.log('注意：此動作只產生本機設定檔，尚未遠端部署。');
