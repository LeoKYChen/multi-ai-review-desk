# Multi-AI 雙 AI 協作工作臺

> 私人使用｜開發中｜目標日期：2026-11-01｜**尚未部署**

你只需交辦一次，**ChatGPT／OpenAI API** 與 **Gemini API** 即可各自分析、互相交換意見，再各自提出修正建議；**只有你能決定採納、退回或結案**。

**目前版本為 v0.7.0 開發版原型**，完成前後端程式與本機自動測試，尚未部署 Cloudflare D1/Workers，也尚未取得或驗證真實模型 API 憑證。

## 架構
- Cloudflare Workers：網頁、任務控制、模型 API 呼叫。
- Cloudflare D1：交辦指令、從 Word 擷取的文字、AI 初稿、交叉意見、個別建議及人工決定。
- 無 R2、無 Google Drive、無 Word 原始檔永久儲存。
- 單一人類審查者，沒有第三個 AI 總審查官。
- 不與觀護人學習平臺整合，也不開發特定題庫、法律研究或文件專用功能。

目前介面提供 Word .docx 上傳（最多 3MB）、登入、任務清單、兩欄 AI 意見及人工最後決定。另加入「網頁版輔助模式」：你在工作臺交辦一次任務，系統依順序產生 ChatGPT 與 Gemini 各階段的完整提示詞。你須自行在兩個網頁版操作並貼回其回覆（兩模型 × 三階段，共六次）；工作臺不會直接登入或讀取這些網頁對話。手動貼入內容會標記為「來源未驗證」。

有模型 API 憑證時可選擇「API 自動模式」。沒有模型憑證時，不會輸出虛構 AI 回覆。

## 驗證
參閱 [Cloudflare 後端說明](cloudflare/README.md)。

## 上線前仍需完成
實際 Cloudflare Worker/D1 部署與端對端驗收；模型 API 憑證及個人預算確認；登入限速及私有存取防護；D1 備份與復原測試。**不要將 API Key 或工作臺登入密碼提交到 GitHub。**

程式參考開源專案 [Feedback Desk](https://github.com/aixwangtw/feedback-desk) 的任務協作概念，但目前不是完整 fork。

## v0.5 登入、費用與備份防護
- 登入失敗採 D1 15 分鐘視窗限制；IP 僅以 HMAC 雜湊儲存，不寫入原始 IP。
- 真實模型 API 呼叫採 **預設關閉**，必須由使用者在 Cloudflare 伺服器環境明確設 `MODEL_API_ENABLED=true` 才能啟動。
- 預設最多每個任務 12 次、全站每天 12 次模型**呼叫嘗試**；單次失敗也計入，以免重試意外增加帳單。這是次數上限，不是金額保證。
- 手動匯出 D1 SQL 備份：`cd cloudflare && npm run backup:remote`（僅使用者本機執行，需要 Wrangler 登入；備份不會上傳 GitHub）。

## 私人測試站部署準備

已新增 **受控、預設不啟動** 的 Cloudflare staging GitHub Actions 工作流程，參閱 [Cloudflare D1 部署指南](docs/Cloudflare_D1_私人測試站部署指南.md)。請先將 D1 ID 和 Account ID 設為 GitHub Variables，將 Cloudflare API Token 和兩個工作臺認證值設為 GitHub Secrets，未授權前不會部署。

## v0.7：不依賴 Cloudflare 部署的新功能

- **匯出完整 Markdown 審查紀錄**：登入後於任務詳情選擇「匯出完整紀錄（MD）」，保存原始交辦、Word 擷取文字、每回合雙 AI 意見、來源註記、人工核定結果與時間。無須儲存 Word 原始檔。匯出的 Markdown 內含私人資料，請勿公開分享。
- **退回理由傳到下一回合**：選擇「退回重新討論」時必須填入具體理由；下一回合兩個 AI 都會看到此人工要求，但本回合的獨立分析仍不會直接看到對方本回合的答案。原始交辦內容保持不可覆寫。
- **網頁版六階段進度**：介面顯示第 1 至 6 步，並繼續清楚標示手動貼入 AI 回覆的來源未驗證狀態。
- 完成新功能的 Node 單元與 API 測試，GitHub CI 自動執行。**本版本仍未部署正式網站**。

### 部署狀態與安全
部署流程已改為**必須由使用者手動啟動**，且須另外滿足部署開關條件；一般推送開發分支不會自動部署。Cloudflare 授權問題暫時擱置，請勿將真實敏感文件上傳未驗收的測試站。
