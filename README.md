# Multi-AI 雙 AI 協作工作臺

> 私人使用｜開發中｜目標日期：2026-11-01｜**尚未部署**

你只需交辦一次，**ChatGPT／OpenAI API** 與 **Gemini API** 即可各自分析、互相交換意見，再各自提出修正建議；**只有你能決定採納、退回或結案**。

**目前版本為 v0.5.0 開發原型**，完成前後端程式與本機自動測試，尚未部署 Cloudflare D1/Workers，也尚未取得或驗證真實模型 API 憑證。

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
