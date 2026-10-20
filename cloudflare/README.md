# Multi-AI 雙 AI 協作工作臺 · Cloudflare 原型

**狀態：尚未部署、尚未實際驗證兩個模型的憑證／費用。** 此版已建立 D1-only API、靜態網頁及 OpenAI/Gemini API 接入程式，但憑證由持有者設定後才能實際執行模型。

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
- `POST /api/tasks/:id/advance`：執行下一階段 AI 請求；每次最多各呼叫兩模型一次，失敗可重試未完成模型。
- `POST /api/tasks/:id/review`：僅由人類登入工作臺進行最終決定；`rework` 可重新建立回合。

**已停用上一版示範型 `POST /api/rounds/:id/outputs` 接口**，避免瀏覽器或外部程序直接冒充 AI 提交內容。模型輸出僅由 Workers 後端呼叫 API 後寫入 D1。

## 測試內容

`npm test` 包含 DOCX 文字解析、登入 Cookie、防跨來源請求、模型初稿隔離、交叉審查上下文、API 參數與模型錯誤遮蔽。另以 SQLite 測試 D1 建表、原文不可覆寫及重複請求鎖定。
