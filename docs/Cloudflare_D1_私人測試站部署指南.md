# Cloudflare D1 測試站部署指南（v0.6 預備）

> 狀態：**自動部署工作流程已建立，但預設不啟動。尚未連到使用者的 Cloudflare 帳號。**
>
> 2026-10-20｜目標：使用已建立的 Cloudflare D1，將 Multi-AI 工作臺部署成**私人測試站**。

## 已決定的架構

- Cloudflare Worker 測試站名稱：`multi-ai-review-desk-staging`，和正式版名稱區隔。
- 既有 D1 資料庫透過 `DB` 綁定，使用 0001～0004 migration 初始化與更新。
- D1 只儲存 Word 擷取文字、交辦指令、AI 討論、各自建議及人工審查；不永久儲存 Word 原檔。
- API 模式預設 `MODEL_API_ENABLED=false`：**不會自動向 OpenAI 或 Gemini API 付費呼叫**。
- 可使用 ChatGPT/Gemini 網頁版輔助模式，但需人工將指令與回覆轉貼，並標註來源未驗證。

## 1. Cloudflare 取得兩個非密碼欄位

1. 登入 https://dash.cloudflare.com/ 。
2. 在 D1 資料庫 `multi-ai-review-desk-db` 的詳細資料頁面找到 **Database ID**，形式像 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`；不要使用其他 D1 資料庫的 ID。
3. 在 Cloudflare 帳號的首頁或帳號設定找 **Account ID**，為 32 位十六進位字元。
4. 若你的資料庫名稱不是 `multi-ai-review-desk-db`，先告訴我實際名稱；勿在不確定綁定目標時執行資料庫遷移。

這兩個 ID 不是密碼，但仍建議只輸入 GitHub Repository Variables，不須貼到公開討論區。

## 2. 在 GitHub 填入 Repository Variables

開啟：
https://github.com/LeoKYChen/multi-ai-review-desk/settings/variables/actions

新增以下 Variables（**不是 Secrets**）：

| Variable 名稱 | 值 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（32 位） |
| `CF_D1_DATABASE_ID` | D1 Database ID（UUID） |
| `ENABLE_STAGING_DEPLOY` | 先保持 `false`，取得你確認後才改 `true` |

程式碼裡沒有填入 ID；GitHub Actions 會在部署前利用這兩個 Variables 產生被 `.gitignore` 忽略的 Wrangler 設定檔。

## 3. 在 Cloudflare 建立最小權限 API Token

官方指引：https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

1. 開啟 Cloudflare Dashboard → Profile → API Tokens，建立自訂 Token。
2. 讓它只能操作**本專案所屬的 Cloudflare Account**，不要使用 Global API Key。
3. 權限依實際 Cloudflare 畫面授予部署所需的 Workers Scripts Edit，以及 D1 Edit（用於 D1 migrations）。若介面權限名稱有差異，先核對官方文件再給權限。
4. 建立後把 Token 放到 GitHub Actions Repository Secret `CLOUDFLARE_API_TOKEN`，**不要貼到聊天室、GitHub 程式碼、Issue 或 Pull Request**。

GitHub Secrets 網址：
https://github.com/LeoKYChen/multi-ai-review-desk/settings/secrets/actions

## 4. 建立另外兩個 GitHub Repository Secrets

| Secret 名稱 | 用途 |
| --- | --- |
| `OWNER_TOKEN` | 工作臺登入 Cookie 的 HMAC 簽章用高熵隨機金鑰，建議以密碼管理員產生至少 32 字元 |
| `OWNER_PASSWORD` | 測試站個人登入密碼，至少 16 字元，不要使用其他網站的現有密碼 |

不需要設定 `OPENAI_API_KEY` 或 `GEMINI_API_KEY`，因為首輪部署**只驗證網頁版輔助模式及 D1**；自動 API 模式不啟用。

**重要**：登入用密碼只在 GitHub Secrets 與 Cloudflare Workers Secrets 內保存，不寫進前端程式碼，也不會經由對話向助理提供。

## 5. 真正部署的門檻

此分支已新增 `.github/workflows/deploy-staging.yml`。只有當 Repository Variable `ENABLE_STAGING_DEPLOY=true`，而且發生對 **`feat/d1-docx-review-v020` 開發分支的下一次 push**，部署工作才會實際執行。

部署工作依序：安全驗證 → 執行本機測試 → 產生 Wrangler 設定 → D1 遷移 → Workers 部署 → 設定 Owner Secrets。**沒填好變數和 Secret 時不能部署成功。**

Cloudflare 會在首次遠端 D1 migration 前依官方機制建立備份；但仍應另外驗證完整匯出及還原流程。

## 6. 首次部署成功後立刻啟用 Cloudflare Access

**不能只靠網站密碼就宣稱對外完全不可見。** Workers 的 `workers.dev` URL 原則上是公開可到達的。

官方操作路徑：
Cloudflare Dashboard → Workers & Pages → `multi-ai-review-desk-staging` → **Access** → **Protect this Worker behind Access** → **All traffic** → 設定僅你本人能登入的電子郵件/帳戶政策 → Apply Access。

官方文件：https://developers.cloudflare.com/workers/configuration/cloudflare-access/

測試：
- 未登入 Cloudflare Access 的瀏覽器應被拒絕進站。
- 通過 Access 但未登入工作臺密碼，只能看到登入畫面，不能讀取 D1 任務或文件內容。
- 登入後可以新增文字任務並查看 D1 紀錄。
- 確認 Word 只會擷取文字，不會永久保存原檔。
- 網頁版輔助模式可完成六個階段，結果標為 `manual_unverified`。
- API 自動模式應顯示未啟用；不會送出計費模型請求。
- 使用測試文字（不含少年個案、個資、機密內容）驗收全部流程後，才考慮存放真實工作資料。

## 7. 尚未完成的上線要求

1. Cloudflare 真實部署及私人 Access 實際驗證。
2. D1 備份 **實際匯出及在獨立測試庫成功還原**。
3. Cloudflare Workers 實際 DOCX 解析、登入及表單端對端測試。
4. 如果要一鍵自動跨 AI，需要個別取得並測試 OpenAI/Gemini API，確認成本、限額及權限。網頁版輔助不等於全自動串接。

任何測試失敗，不合併 `main`，不宣稱正式上線。
