# Feedback Desk｜Phase 7 私人 Cloudflare Staging 安全啟動指南

日期：2026-10-21。分支：feat/d1-docx-review-v020；PR #1 仍為 Draft。
狀態：安全部署流程已提交開發分支，尚未部署至 Cloudflare；目前沒有可用的測試站網址。

## 一、先建立無公開網址的封閉 Worker

Cloudflare D1 必須**另外建立一個全新空白資料庫**，名稱精確為 multi-ai-review-desk-staging-db，不得使用既有 multi-ai-review-desk-db 或正式資料庫。部署前會以 Wrangler 遠端唯讀清單核對 DB 名稱和 UUID，失敗就拒絕套用 migration。
第一階段選 provision_closed；Worker 名稱 multi-ai-review-desk-staging。workers_dev=false，preview_urls=false，沒有 public route。MODEL_API_ENABLED=false、BACKGROUND_JOBS_ENABLED=false，不配置 OpenAI、Gemini 或 Queue。部署成功也還沒有瀏覽器可用的網址。

## 二、使用者自己的 GitHub 設定（不需要向助理提供憑證）

GitHub Repository Variables：https://github.com/LeoKYChen/multi-ai-review-desk/settings/variables/actions

| 名稱 | 用途或設定 |
|---|---|
| CLOUDFLARE_ACCOUNT_ID | 自己的 Cloudflare Account ID |
| CF_STAGING_D1_DATABASE_ID | 新的獨立 staging D1 UUID |
| CF_D1_DATABASE_ID | 如已設定既有 DB，保留供隔離對照；部署不使用它 |
| ENABLE_STAGING_DEPLOY | 準備好前維持 false；本人確認後才改 true |
| ACCESS_POLICY_VERIFIED | 初始維持 false |
| STAGING_ACCESS_URL | 只在第二階段填入 staging 的 workers.dev 完整網址 |

GitHub Repository Secrets：https://github.com/LeoKYChen/multi-ai-review-desk/settings/secrets/actions

| 名稱 | 用途 |
|---|---|
| CLOUDFLARE_API_TOKEN | 只具備本次部署所需權限的 Cloudflare API Token |
| OWNER_TOKEN | 至少 32 字元高熵隨機值，供私人工作臺簽名 |
| OWNER_PASSWORD | 至少 16 字元工作臺獨立密碼 |

不要貼出任何 Token、API Key 或密碼，也不要設定或啟用付費 OpenAI、Gemini API。

## 三、建立 Worker 後，先用 Cloudflare Access 保護整個 Worker

Cloudflare Dashboard → Workers & Pages → multi-ai-review-desk-staging → Access → Protect this Worker behind Access → All traffic。政策只允許本人，建議使用明確帳號／電子郵件，不要開放整個組織或使用 Everyone。
確認後才在 GitHub 將 ACCESS_POLICY_VERIFIED 設為 true，並填 STAGING_ACCESS_URL，再手動選 activate_after_access。這一步才會啟用 workers.dev（預覽仍停用）。
CI 會以未登入訪客測試必須收到 Cloudflare Access 登入導向或拒絕；若回傳一般網頁，會失敗並嘗試把 workers.dev 改回關閉。回復依賴 Cloudflare 網路仍可用，因此**在真正驗證 Access 前不得放入私人或真實案件資料**。

官方文件：https://developers.cloudflare.com/workers/configuration/cloudflare-access/

## 四、目前的 GitHub 工作流程啟動限制

GitHub 官方要求手動 workflow_dispatch 工作流程先存在預設分支。目前部署檔只在開發分支、main 尚無該工作流程，因此 GitHub UI 不一定會出現 Run workflow。
可選擇：（A）本人另外授權，僅在 main 新增極小的手動部署啟動入口，程式仍指向固定開發分支，不合併 PR；（B）本人在安全電腦使用 Wrangler 手動完成兩階段部署。兩者都須先確認獨立測試 D1 與私人 Access；本次未擅自更動 main。
官方文件：https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

## 五、使用合成資料的驗收

未通過 Access 時不能看到網站；通過 Access 但沒登入工作臺仍不能讀取 API。登入後只用虛構文字／虛構 DOCX 測試六段人工 AI 回覆、草稿版本衝突、人工核定 v1/v2、異議、來源查證及 Markdown 匯出。確認模型 API 及背景自動工作均為關閉。
真實手機及桌面瀏覽器操作、遠端 D1 備份還原及 Access 未登入阻擋仍需實測；不把隔離測試當作正式上線。

停止點：部署檔已備妥，但獨立 D1、GitHub Secret／Variable、Cloudflare Access 與預設分支啟動入口均須本人在帳號內完成或明確授權。
