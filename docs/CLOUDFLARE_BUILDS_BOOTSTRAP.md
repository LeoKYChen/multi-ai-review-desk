# Feedback Desk｜Cloudflare 官方 GitHub 整合替代部署方案：封閉引導階段

更新：2026-10-22。僅適用分支 `staging/cloudflare-builds-bootstrap`。

## 目的與現況

目前 GitHub Actions 使用的 Token 可以成功通過 Cloudflare 驗證，但對 D1 list 與 direct GET 都收到 HTTP 401 / code 10000。**不要再用原工作流程反覆部署，也不要跳過資料庫辨識驗證。**

本分支先建立一個**無功能、不可存資料、回覆 503** 的暫時 Worker，以測試 Cloudflare 官方 GitHub 整合能否部署 Worker，並預先配置 Worker-level Access。

- Worker 名稱：`multi-ai-review-desk-staging`
- Worker 程式：`cloudflare/src/staging-bootstrap.mjs`，所有請求都只回 HTTP 503
- 設定：`cloudflare/wrangler.jsonc`，`workers_dev=false`、`preview_urls=false`
- **不含 D1 binding、不初始化 D1、不套用 migrations**
- 不包含登入程式、任務資料、真實文稿或付費模型呼叫
- 不需要設定或複製 GitHub Actions 使用的 `CLOUDFLARE_API_TOKEN`
- `main` 與既有開發 PR 不合併；未完成驗收前勿改成正式程式

這是**受控的 503 引導程式**，**不是可使用的測試網站**。即使意外出現可存取的 URL，也不會提供業務內容，但仍應儘速啟用 Cloudflare Access。

## 一、使用 Cloudflare 官方 Workers Builds 建立引導 Worker

1. Cloudflare Dashboard → **Workers & Pages** → **Create application** → 選 **GitHub**（或 Import repository）。
2. 授權 Cloudflare GitHub 整合，只選存取必要的私人儲存庫：`LeoKYChen/multi-ai-review-desk`。
3. **務必先確認可以選擇以下建置設定，才點 Save and Deploy**：
   - Repository：`LeoKYChen/multi-ai-review-desk`
   - **Production branch：`staging/cloudflare-builds-bootstrap`**（不是 `main`）
   - **Root directory：`cloudflare`**
   - Worker name：`multi-ai-review-desk-staging`（名稱須與 wrangler 設定一致）
   - Build command：`npm install --no-fund --no-audit && npm test`
   - Deploy command：`npx wrangler deploy --config wrangler.jsonc`
   - Build API Token：優先選擇 **Cloudflare 官方新建／自動產生的建置 Token**，不要選先前回報 D1 401 的舊 Token
   - Preview builds：**Disable / OFF**（建置完成後再到 Settings > Build > Branch control 複查）
4. 若設定頁無法指定 production branch、root、Worker 名稱或安全設定，**先不要執行 Save and Deploy**，避免從錯誤分支自動公開部署。
5. 如果官方整合仍回報授權錯誤，先保留建置日誌，不要將服務改為公開來繞過。

提醒：有些 Cloudflare 介面在首次匯入時會立即觸發一次建置和部署。因本分支僅包含 503 引導程式，尚未放入私人資料。成功部署後仍須逐一確認網路設定，不應假設沒有公開入口。

## 二、設定私人存取，且不影響其他 Worker

1. Cloudflare Dashboard → Workers & Pages → `multi-ai-review-desk-staging`。
2. **Settings → Domains & Routes**：確認 `workers.dev` 為 Disabled、Preview URLs 為 Disabled；沒有額外 custom domain / routes。
3. 開啟 Worker 專屬的 **Access** 分頁 → **Protect this Worker behind Access** → 選 **All traffic**；僅授權本人可登入的電子郵件，別選 Everyone／整個 email domain。
4. 不要擅自啟用全帳號「Protect all Workers」，以免影響其他現有網站。
5. Access 設定完成後，仍應從無痕視窗確認匿名請求無法存取 Worker；正式站接入前需實際驗收。

## 三、下一階段才接入 D1 及正式功能

Cloudflare 官方的 Worker Builds **不會自動解決 D1 API 401**；內建建置 Token 也不保證具備 D1 權限。

- 在 Cloudflare D1 控制臺核對獨立測試資料庫 `multi-ai-review-desk-staging-db` 的確切名稱、ID 與帳號；不可碰既有正式 DB。
- 先確定能以適當授權、安全完成 staging 的建表 migration，並維持既有 `d1_migrations` 追蹤狀態；若要在 Dashboard SQL Console 手動執行，須先規劃交易、遷移紀錄及回復方式。
- 真正上線前才把 Worker 程式換成 `src/worker.mjs`、加上獨立 D1 binding、伺服器密鑰與靜態資產；**維持 Cloudflare Access 全流量保護**。
- 模型 API、背景 Queue 和真實個案資料仍一律不啟用。
- 上傳任何私人文稿前，至少完成 Access 未登入阻擋、登入保護、測試資料庫辨識及備份還原的真實環境驗收。

## 常見問題

**為何不直接部署完整 App？** 目前 D1 授權不通，且完整 App 涉及資料庫與登入。先用不含私密內容的占位 Worker 區分「Worker 發布問題」與「D1 權限問題」，能縮小排查範圍而不增加暴露風險。

**這是否已完成測試站？** 否。部署此分支最多只能建立永遠回覆 503 的 Cloudflare Worker。此階段不會讓手機或電腦使用完整工作臺。

官方文件：
- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
