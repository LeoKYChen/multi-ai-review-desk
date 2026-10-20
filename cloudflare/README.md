# D1-only 開發後端

目前為 Workers API + D1 schema 原型。**尚未部署、未接上真實 ChatGPT/Gemini。**
無 Cloudflare R2、Google Drive 綁定；Word（.docx）原始位元組僅於上傳請求內解析，不永久保留。

## 建立 Cloudflare D1 資料庫

1. 在 Cloudflare 帳號建立 D1 資料庫 `multi-ai-review-desk-db`。
2. 複製 `wrangler.toml.example` 為 `wrangler.toml`，填入真實 D1 database_id，**不要提交 `wrangler.toml`**。
3. 執行 `npm install`、`npx wrangler d1 migrations apply multi-ai-review-desk-db --local`。
4. 在正式部署前，透過 `npx wrangler secret put OWNER_TOKEN` 設定長度至少 32 的隨機密鑰，勿放到版控、前端或 URL。
5. 驗證 `npm test`。雲端部署與私有登入機制仍須另行驗收。

**注意：**`node:zlib` 用於處理 .docx 壓縮檔；Workers 部署時須開啟 `nodejs_compat` 旗標（範本已加入）。

## 原型 API

- `POST /api/tasks`：multipart/form-data，含 `title`、`instruction`、選填 `document` (.docx)；只儲存擷取文字。
- `GET /api/tasks`：最近任務。
- `GET /api/tasks/:id`：原文、各回合、兩 AI 意見與人類決定。
- `POST /api/tasks/:id/rounds`：建立回合，但**不會啟動真實 AI**。
- `POST /api/rounds/:id/outputs`：儲存指定模型與階段的輸出（僅開發用，正式版必須將 AI 寫入與人類審核憑證分離）。
- `POST /api/tasks/:id/review`：人類核定（原型用 OWNER_TOKEN，正式版須完善權限區分）。

所有原型 API 需 `Authorization: Bearer <OWNER_TOKEN>`；未授權或未設定密鑰會拒絕要求。

**公開部署前安全待辦：** 前端安全登入、服務端 AI 身分驗證、限制寫入介面、跨請求併發控制、D1 資料匯出/還原及錯誤重試。切勿將 OWNER_TOKEN 直接嵌在前端 JS 中。
