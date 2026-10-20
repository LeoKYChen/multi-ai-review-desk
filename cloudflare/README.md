# Multi-AI 雙 AI 協作工作臺 · Cloudflare 原型

**狀態：尚未部署、尚未實際驗證兩個模型的憑證／費用。** 此版已建立 D1-only API、靜態網頁、網頁版輔助模式及 OpenAI/Gemini API 接入程式，但憑證由持有者設定後才能實際執行模型。

## 架構及限制

- Workers：提供登入入口、網頁介面與三階段模型 API 請求。
- D1：僅保存交辦文字、Word 擷取文字、雙模型初稿、互評、修正建議與人工決定。
- 僅支援 .docx（3 MB 以內；文字 50,000 字元以內）。圖片、註解、頁首頁尾及複雜格式不保留。**Word 原始檔不寫入 D1、R2 或 Google Drive。**
- 文字長度超過約 24,000 字元時，模型請求將明確拒絕，不會默默截斷原始文稿。
- 不自動合併、修改原稿；兩個模型各自給出修正建議，最終決定只從人工登入畫面提交。
- OpenAI API ≠ ChatGPT 網頁訂閱；Gemini API ≠ Gemini 網頁訂閱。使用可能另行計費。模型名稱未預設，需自行指定。
- 本版是獨立 D1-only 原型，不是 Feedback Desk 原專案的完整移植。

## 開發測試

Node.js 22 建議，執行：

```bash
cd cloudflare
npm install
npm test
python3 test/check_schema.py
```

## Cloudflare 部署前準備（尚未執行）

1. 建立 Cloudflare D1 資料庫 `multi-ai-review-desk-db`。
2. 把 `wrangler.toml.example` 複製為 `wrangler.toml`，填入 D1 database_id。`wrangler.toml` 已在 Git 忽略清單。
3. 執行 `npx wrangler d1 migrations apply multi-ai-review-desk-db --local` 驗證；要部署才執行 `--remote`。
4. 將以下密鑰設定為 Workers **Secrets**：`OWNER_TOKEN`（隨機至少 32 字元）、`OWNER_PASSWORD`（至少 16 字元）、`OPENAI_API_KEY`、`GEMINI_API_KEY`。**不得提交 GitHub**。
5. 設定非機密環境變數 `OPENAI_MODEL`、`GEMINI_MODEL`，具體模型需確認兩個 API 帳號可用。
6. 先確認 API 費用及額度設定，再將測試站設為私人存取。上線前仍需強化登入防暴力嘗試、模型請求成本限制、D1 備份與 Cloudflare Workers 端對端驗收。

在上述條件滿足前，不應直接作為公開正式站部署。**不要把 OWNER_TOKEN、API Key 放在瀏覽器、網頁程式或 GitHub。**

## 使用介面

`public/index.html`、`public/app.js` 和 `public/style.css` 透過 Workers 靜態資產服務提供。登入後建立任務、上傳 Word、查看雙 AI 意見、交付人類最終審查；模型未設定時不會輸出模擬結果。

## 主要 API

- `POST /api/login`、`GET /api/session`、`POST /api/logout`：Cookie 登入（HttpOnly/Secure/SameSite=Strict）。
- `GET /api/settings`：僅顯示兩個模型是否設定，不回傳 API Key。
- `POST /api/tasks`：一次交辦，可附 .docx；只儲存擷取文字。
- `GET /api/tasks`、`GET /api/tasks/:id`：查詢清單與完整審查紀錄。
- `POST /api/tasks/:id/advance`：僅 API 模式；執行下一階段模型 API 請求，失敗可重試未完成模型。
- `POST /api/tasks/:id/manual-begin`：僅網頁版輔助模式；建立手動審查回合。
- `GET /api/tasks/:id/manual-next`：取得下一個待執行模型及完整階段提示詞。
- `POST /api/tasks/:id/manual-output`：由你貼回模型回覆，標記 `manual_unverified`，不宣稱已驗證模型來源。
- `POST /api/tasks/:id/review`：僅由人類登入工作臺進行最終決定；`rework` 可重新建立回合。

**注意：網頁版輔助模式無法一鍵代替你操控兩個網頁帳號，必須自行將階段指令與 AI 回覆轉貼，這只是無 API 的過渡方案。**

**已停用上一版示範型 `POST /api/rounds/:id/outputs` 接口**，避免瀏覽器或外部程序直接冒充 AI 提交內容。模型輸出僅由 Workers 後端呼叫 API 後寫入 D1。

## 測試內容

`npm test` 包含 DOCX 文字解析、登入 Cookie、防跨來源請求、模型初稿隔離、交叉審查上下文、API 參數與模型錯誤遮蔽。另以 SQLite 測試 D1 建表、原文不可覆寫及重複請求鎖定。

## v0.5 安全及成本護欄

- 系統會以 D1 記錄登入失敗。相同來源在 15 分鐘內連續錯誤達 5 次，暫停登入 15 分鐘；此措施仍需搭配 Cloudflare Access/其他邊緣流量防護。
- 伺服器需明確設 `MODEL_API_ENABLED=true` 才能開啟模型 API。僅設定 API Key 不會發出模型請求。
- `MODEL_MAX_CALLS_PER_TASK` 預設 12 次，`MODEL_MAX_CALLS_PER_DAY` 預設 12 次；皆是**呼叫嘗試次數**，失敗也會計入，並非實際計費上限或美元上限。建議先設低一些（例如每天 4 次）進行測試。
- `npm run backup:remote`：由使用者本機執行 `wrangler d1 export --remote` 匯出完整 SQL，保存至儲存庫外的 `private-backups/`。備份內容可能涉及個人資訊，應放在加密磁碟及安全位置，不要提交 GitHub。
- 重建資料庫前先備份，回復作業應先在**另一個測試用 D1 資料庫**驗證 SQL 匯入，不可未核對就覆蓋正式資料。官方參考：https://developers.cloudflare.com/d1/best-practices/import-export-data/

注意：此版還未經真實 Cloudflare Worker/D1 部署、真實 API 帳號及網路安全壓力測試；切勿誤認已達生產環境驗收標準。

## 使用現有 D1 建立測試站（尚未部署）

新的部署工作流程 `deploy-staging.yml` 採 GitHub Actions opt-in，預設不執行；需由使用者在 GitHub 安全設定頁填入非機密的 D1 與 Cloudflare Account ID，以及部署 Token 與個人登入密碼等 Secrets。步驟見[Cloudflare D1 私人測試站部署指南](../docs/Cloudflare_D1_私人測試站部署指南.md)。目前須從 GitHub Actions 明確手動觸發並通過確認條件才可能部署。正式操作私人文件前，須先啟用 Cloudflare Access。

## v0.7 原文保存、退回重議與 Markdown 匯出

- `GET /api/tasks/:id/export.md`：僅登入使用者可下載此任務的**完整 Markdown 審查歷程**。匯出包含原始指令、Word 擷取文字、每回合 AI 訊息與人工決定；不包含 Word 原始檔位元組。
- 原文／回覆以動態 Markdown code fence 保留完整字元（包括 Markdown 特殊符號），避免匯出時把文書內的標記誤認成報告章節。來源為手動貼入者明確標示「來源未驗證」。
- 選擇 `rework` 必須提供非空白理由。下一回合的提示詞保留**前次人類退回理由**，並維持 ChatGPT/Gemini 獨立初稿的隔離。
- 網頁版顯示六步驟進度。新功能均可在 GitHub Actions 進行單元測試，不需要部署 Cloudflare 或輸入 API Key。

**更正舊版說明：** staging 部署工作已由自動 push 改為需要人工 `workflow_dispatch`、指定確認字串及 `ENABLE_STAGING_DEPLOY=true` 三項條件，不能單靠 push 自動部署。

## 離線 v0.8 功能移植（雲端原型，尚未部署）

- 新增 `migrations/0005_task_category.sql`，對既有 D1 任務設定預設分類「一般」，並建立分類索引。**尚未對遠端 D1 執行 migration**。
- `POST /api/tasks` 現在可提交 `category`，最多 30 字元，原始交辦、Word 文字依舊不可被覆寫。
- `GET /api/tasks?q=...&status=...&category=...` 支援參數化搜尋與狀態、分類篩選，最多回傳 100 筆。搜尋文字絕不直接拼接 SQL。
- 登入後介面新增任務分類、搜尋、狀態和分類篩選，以及每回合 0 至 6 份模型意見的進度顯示。
- **離線 JSON 備份尚未支援直接匯入 D1**；這是不同的資料格式。離線單檔仍在 [offline/index.html](../offline/index.html)，不接雲端 D1。
- 仍需實際 Cloudflare Workers/D1 授權、環境部署及端對端操作驗收；目前不適合存入私人敏感資料。

## v0.9 前端開發：歷次回合比較（尚未部署）

已同步離線版的歷次回合閱讀模式至雲端前端程式：可切換回合、只看某一階段 ChatGPT 與 Gemini 的意見、檢視該回合人工採納或退回的說明。瀏覽歷史時不能對舊回合送出新核定；最新回合的 AI 執行進度與提交流程不受歷史篩選影響。資料庫仍使用原有 task_rounds / ai_outputs / human_decisions，不需新增 D1 migration。本功能只完成程式與 CI 語法、結構測試，**未實際部署到 Cloudflare，也未在遠端瀏覽器驗收**。
